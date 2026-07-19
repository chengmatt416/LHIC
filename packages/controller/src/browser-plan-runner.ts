import {
  isBrowserExecutionPlan,
  type ActionExecutionResult,
  type BrowserExecutionPlan,
  type BrowserSemanticAction,
  type VerificationResult,
} from "@lhic/schema";
import {
  createActionApproval,
  evaluateRisk,
  validateActionApproval,
  type ActionApproval,
} from "@lhic/security";

export interface BrowserPlanActionExecutor {
  execute(
    action: BrowserSemanticAction,
    approval?: ActionApproval,
  ): Promise<ActionExecutionResult>;
  rememberVerifiedAction?(
    action: BrowserSemanticAction,
    verification: VerificationResult,
  ): boolean;
}

export interface BrowserPlanVerifier {
  verify(
    condition: BrowserExecutionPlan["steps"][number]["verification"],
  ): Promise<VerificationResult>;
}

export interface BrowserPlanStepOutcome {
  stepId: string;
  execution: ActionExecutionResult;
  verification: VerificationResult;
}

export interface BrowserPlanRunOptions {
  startAt?: number;
  approvals?: Readonly<Record<string, ActionApproval | undefined>>;
  /** Demo and MCP batch execution always confirm activation events. */
  requireActivationApproval?: boolean;
  approvedBy?: string;
  approvalScope?: string;
}

export type BrowserPlanRunResult =
  | {
      status: "completed";
      completedSteps: BrowserPlanStepOutcome[];
      nextStepIndex: number;
    }
  | {
      status: "awaiting_approval";
      completedSteps: BrowserPlanStepOutcome[];
      nextStepIndex: number;
      stepId: string;
      approval: ActionApproval;
    }
  | {
      status: "failed";
      completedSteps: BrowserPlanStepOutcome[];
      nextStepIndex: number;
      stepId: string;
      error: string;
    };

/**
 * Runs a pre-built plan only. It has no model or MCP dependency, making this
 * the shared execution boundary for CLI and harness Fast Path flows.
 */
export async function executeBrowserPlan(
  plan: BrowserExecutionPlan,
  executor: BrowserPlanActionExecutor,
  verifier: BrowserPlanVerifier,
  options: BrowserPlanRunOptions = {},
): Promise<BrowserPlanRunResult> {
  if (!isBrowserExecutionPlan(plan)) {
    throw new Error(
      "Browser plan does not satisfy the browser-plan-v1 contract.",
    );
  }
  const startAt = options.startAt ?? 0;
  if (
    !Number.isSafeInteger(startAt) ||
    startAt < 0 ||
    startAt > plan.steps.length
  ) {
    throw new Error("Browser plan startAt is outside the plan step range.");
  }

  const completedSteps: BrowserPlanStepOutcome[] = [];
  for (let index = startAt; index < plan.steps.length; index += 1) {
    const step = plan.steps[index]!;
    const approvalRequired = requiresApproval(
      step.action,
      options.requireActivationApproval ?? false,
    );
    const suppliedApproval = options.approvals?.[step.id];
    if (approvalRequired) {
      const approval =
        suppliedApproval ??
        createActionApproval(
          step.action,
          options.approvedBy ?? "pending-human-approval",
          options.approvalScope ? { scope: options.approvalScope } : {},
        );
      const decision = validateActionApproval(
        step.action,
        suppliedApproval,
        new Date(),
        {
          forceConfirmation: true,
          ...(options.approvalScope
            ? { expectedScope: options.approvalScope }
            : {}),
          confirmationReason:
            "The batch plan requires human approval for this activation or high-risk action.",
        },
      );
      if (!decision.allowed) {
        return {
          status: "awaiting_approval",
          completedSteps,
          nextStepIndex: index,
          stepId: step.id,
          approval,
        };
      }
    }

    const execution = await executor.execute(step.action, suppliedApproval);
    if (!execution.success) {
      return {
        status: "failed",
        completedSteps,
        nextStepIndex: index,
        stepId: step.id,
        error: execution.error ?? "The browser action did not complete.",
      };
    }
    const verification = await verifier.verify(step.verification);
    const outcome = { stepId: step.id, execution, verification };
    completedSteps.push(outcome);
    if (!verification.success || verification.evidence.length === 0) {
      return {
        status: "failed",
        completedSteps,
        nextStepIndex: index,
        stepId: step.id,
        error:
          verification.error ??
          "The required post-action verifier did not produce evidence.",
      };
    }
    executor.rememberVerifiedAction?.(step.action, verification);
  }

  return {
    status: "completed",
    completedSteps,
    nextStepIndex: plan.steps.length,
  };
}

export function resolveBrowserPlanVariables(
  plan: BrowserExecutionPlan,
  values: Readonly<Record<string, string>>,
): BrowserExecutionPlan {
  const missing = plan.requiredVariables.filter(
    (variable) => !values[variable.name]?.trim(),
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required browser-plan variables: ${missing.map((variable) => variable.name).join(", ")}.`,
    );
  }
  const declaredVariables = new Set(
    plan.requiredVariables.map((variable) => variable.name),
  );
  for (const step of plan.steps) {
    if (
      typeof step.action.value === "string" &&
      isVariableExpression(step.action.value) &&
      !declaredVariables.has(variableName(step.action.value))
    ) {
      throw new Error(
        `Browser plan references undeclared variable ${variableName(step.action.value)}.`,
      );
    }
  }
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      action: {
        ...step.action,
        ...(typeof step.action.value === "string"
          ? { value: substituteVariable(step.action.value, values) }
          : {}),
      },
    })),
  };
}

function substituteVariable(
  value: string,
  values: Readonly<Record<string, string>>,
): string {
  const match = variableExpression(value);
  return match ? (values[match[1]!] ?? value) : value;
}

function isVariableExpression(value: string): boolean {
  return variableExpression(value) !== null;
}

function variableName(value: string): string {
  return variableExpression(value)?.[1] ?? "";
}

function variableExpression(value: string): RegExpExecArray | null {
  return /^\{\{variables\.([A-Za-z][A-Za-z0-9_-]*)\}\}$/.exec(value);
}

function requiresApproval(
  action: BrowserSemanticAction,
  requireActivationApproval: boolean,
): boolean {
  const riskDecision = evaluateRisk(action);
  return (
    riskDecision.requiresConfirmation ||
    (requireActivationApproval &&
      (action.type === "click" ||
        action.type === "press" ||
        action.type === "download"))
  );
}
