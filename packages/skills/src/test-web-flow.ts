import type { SemanticAction, VerificationCondition } from "@lhic/schema";
import { isVerificationCondition } from "@lhic/schema";
import { evaluateRisk, type ActionApproval } from "@lhic/security";
import { PlaywrightDirectExecutor } from "@lhic/browser";

import {
  createSkillTrace,
  skillFailure,
  type SkillContext,
  type SkillResult,
} from "./skill-types.js";

export interface DurableWorkflowLookup {
  get(taskId: string): {
    lastCompletedStep: number;
    url: string;
    cookiesJson: string;
    localStorageJson: string;
    sessionStorageJson: string;
  } | undefined;
  save(state: {
    taskId: string;
    workflowName: string;
    lastCompletedStep: number;
    url: string;
    cookiesJson: string;
    localStorageJson: string;
    sessionStorageJson: string;
  }): void;
  delete(taskId: string): void;
}

export interface TestWebFlowInput {
  steps: SemanticAction[];
  successConditions: VerificationCondition[];
  stopBeforeHighRisk?: boolean;
  approvals?: Record<number, ActionApproval>;
  durableStore?: DurableWorkflowLookup;
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

  let startStepIndex = 0;
  const taskId = context.taskId ?? "test-web-flow";

  // Hydration state restoration
  if (input.durableStore) {
    const savedState = input.durableStore.get(taskId);
    if (savedState) {
      await trace.emit("test_web_flow_hydration_started", {
        savedStep: savedState.lastCompletedStep,
        url: savedState.url,
      });
      try {
        const cookies = JSON.parse(savedState.cookiesJson);
        await context.page.context().addCookies(cookies);

        const isRealUrl = savedState.url && (savedState.url.startsWith("http://") || savedState.url.startsWith("https://"));

        if (isRealUrl) {
          await context.page.goto(savedState.url, { waitUntil: "domcontentloaded" });
        }

        await context.page.evaluate(
          (data) => {
            try {
              localStorage.clear();
              const parsedLocal = JSON.parse(data.local);
              for (const [k, v] of Object.entries(parsedLocal)) {
                localStorage.setItem(k, v as string);
              }
            } catch {
              // Ignore security error on unique origin (about:blank)
            }

            try {
              sessionStorage.clear();
              const parsedSession = JSON.parse(data.session);
              for (const [k, v] of Object.entries(parsedSession)) {
                sessionStorage.setItem(k, v as string);
              }
            } catch {
              // Ignore security error on unique origin (about:blank)
            }
          },
          { local: savedState.localStorageJson, session: savedState.sessionStorageJson },
        );

        if (isRealUrl) {
          await context.page.reload({ waitUntil: "domcontentloaded" });
        }
        startStepIndex = savedState.lastCompletedStep;
        await trace.emit("test_web_flow_hydration_completed", { startStepIndex });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Hydration error";
        await trace.emit("test_web_flow_hydration_failed", { error: msg });
      }
    }
  }

  for (const [index, action] of input.steps.entries()) {
    if (index < startStepIndex) {
      evidence.push(`Skipped step ${index + 1} (already completed and hydrated).`);
      continue;
    }

    const approval = input.approvals?.[index];
    const policy = evaluateRisk(action);
    if (
      input.stopBeforeHighRisk &&
      policy.requiresConfirmation &&
      approval === undefined
    ) {
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
    const execution = await executor.execute(action, approval);
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

    // Save current step progress to the durable store
    if (input.durableStore) {
      try {
        const cookies = await context.page.context().cookies();
        const local = await context.page.evaluate(() => {
          try {
            return JSON.stringify(localStorage);
          } catch {
            return "{}";
          }
        });
        const session = await context.page.evaluate(() => {
          try {
            return JSON.stringify(sessionStorage);
          } catch {
            return "{}";
          }
        });
        input.durableStore.save({
          taskId,
          workflowName: "test-web-flow",
          lastCompletedStep: index + 1,
          url: context.page.url(),
          cookiesJson: JSON.stringify(cookies),
          localStorageJson: local,
          sessionStorageJson: session,
        });
        await trace.emit("test_web_flow_state_saved", { step: index + 1 });
      } catch {
        // ignore state saving error
      }
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

  // Clear state on successful workflow completion
  if (input.durableStore) {
    try {
      input.durableStore.delete(taskId);
      await trace.emit("test_web_flow_state_cleared", { taskId });
    } catch {
      // ignore
    }
  }

  await trace.emit("test_web_flow_verified", {
    successConditionCount: input.successConditions.length,
  });
  return { success: true, evidence, traces: trace.events };
}
