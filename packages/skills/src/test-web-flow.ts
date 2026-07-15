import type { SemanticAction, VerificationCondition } from "@lhic/schema";
import { isVerificationCondition } from "@lhic/schema";
import { evaluateRisk } from "@lhic/security";
import { PlaywrightDirectExecutor } from "@lhic/browser";

import {
  createSkillTrace,
  skillFailure,
  type SkillContext,
  type SkillResult,
} from "./skill-types.js";

export interface TestWebFlowInput {
  steps: SemanticAction[];
  successConditions: VerificationCondition[];
  stopBeforeHighRisk?: boolean;
}

function inlineCondition(
  action: SemanticAction,
): VerificationCondition | undefined {
  if (
    !action.value ||
    typeof action.value !== "object" ||
    !("verification" in action.value)
  ) {
    return undefined;
  }
  const condition = (action.value as { verification?: unknown }).verification;
  return isVerificationCondition(condition) ? condition : undefined;
}

export async function testWebFlow(
  context: SkillContext,
  input: TestWebFlowInput,
): Promise<SkillResult> {
  const trace = createSkillTrace(context);
  const executor = new PlaywrightDirectExecutor(context.page, {
    taskId: context.taskId ?? "test-web-flow",
    ...(context.traceFilePath ? { traceFilePath: context.traceFilePath } : {}),
  });
  const evidence: string[] = [];
  await trace.emit("test_web_flow_started", { stepCount: input.steps.length });

  for (const [index, action] of input.steps.entries()) {
    const policy = evaluateRisk(action);
    if (input.stopBeforeHighRisk && policy.requiresConfirmation) {
      await trace.emit(
        "test_web_flow_requires_human",
        { step: index + 1, reason: policy.reason },
        action.riskLevel,
      );
      return skillFailure(
        trace,
        `Stopped before step ${index + 1}: ${policy.reason}`,
        true,
      );
    }
    const execution = await executor.execute(action);
    if (!execution.success) {
      await trace.emit(
        "test_web_flow_step_failed",
        { step: index + 1, error: execution.error },
        action.riskLevel,
      );
      return skillFailure(
        trace,
        execution.error ?? `Step ${index + 1} failed.`,
      );
    }
    evidence.push(...execution.evidence);
    await trace.emit("test_web_flow_step_completed", { step: index + 1 });

    const condition = inlineCondition(action);
    if (condition) {
      const verification = await context.verifier.verify(condition);
      if (!verification.success) {
        await trace.emit("test_web_flow_step_verification_failed", {
          step: index + 1,
          error: verification.error,
        });
        return skillFailure(
          trace,
          verification.error ?? `Step ${index + 1} failed verification.`,
        );
      }
      evidence.push(...verification.evidence);
    }
  }

  for (const condition of input.successConditions) {
    const verification = await context.verifier.verify(condition);
    if (!verification.success) {
      await trace.emit("test_web_flow_verification_failed", {
        error: verification.error,
      });
      return skillFailure(
        trace,
        verification.error ?? "Flow success condition failed.",
      );
    }
    evidence.push(...verification.evidence);
  }

  await trace.emit("test_web_flow_verified", {
    successConditionCount: input.successConditions.length,
  });
  return { success: true, evidence, traces: trace.events };
}
