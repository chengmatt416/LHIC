import {
  isBrowserExecutionPlan,
  type ActionExecutionResult,
  type BrowserExecutionPlan,
  type BrowserSemanticAction,
  type VerificationResult,
} from "@lhic/schema";
import {
  actionRequiresApproval,
  createActionApproval,
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
  /** The validated, action-bound approval used for this step, when required. */
  approvalReceipt?: ActionApproval;
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
    const approvalRequired = actionRequiresApproval(step.action, {
      requireActivationApproval: options.requireActivationApproval ?? false,
    });
    const suppliedApproval = options.approvals?.[step.id];
    let approvalReceipt: ActionApproval | undefined;
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
          confirmationReason: approvalRequired,
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
      approvalReceipt = suppliedApproval;
    }

    let execution: ActionExecutionResult;
    try {
      execution = await executor.execute(step.action, suppliedApproval);
    } catch (error) {
      return {
        status: "failed",
        completedSteps,
        nextStepIndex: index,
        stepId: step.id,
        error:
          error instanceof Error && error.message.trim()
            ? `Browser action executor failed: ${error.message.trim()}`
            : "Browser action executor failed.",
      };
    }
    if (!execution.success) {
      return {
        status: "failed",
        completedSteps,
        nextStepIndex: index,
        stepId: step.id,
        error: execution.error ?? "The browser action did not complete.",
      };
    }
    let verification: VerificationResult;
    try {
      verification = await verifier.verify(step.verification);
    } catch (error) {
      return {
        status: "failed",
        completedSteps,
        nextStepIndex: index,
        stepId: step.id,
        error:
          error instanceof Error && error.message.trim()
            ? `Browser plan verifier failed: ${error.message.trim()}`
            : "Browser plan verifier failed.",
      };
    }
    const outcome = {
      stepId: step.id,
      execution,
      verification,
      ...(approvalReceipt ? { approvalReceipt } : {}),
    };
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
    try {
      executor.rememberVerifiedAction?.(step.action, verification);
    } catch {
      // Optional learning must not turn a verified physical action into a retry.
    }
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
    assertDeclaredVariable(step.action.value, declaredVariables);
    assertDeclaredVariable(step.action.filePath, declaredVariables);
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
        ...(typeof step.action.filePath === "string"
          ? { filePath: substituteVariable(step.action.filePath, values) }
          : {}),
      },
    })),
  };
}

function assertDeclaredVariable(
  value: unknown,
  declaredVariables: ReadonlySet<string>,
): void {
  if (
    typeof value === "string" &&
    isVariableExpression(value) &&
    !declaredVariables.has(variableName(value))
  ) {
    throw new Error(
      `Browser plan references undeclared variable ${variableName(value)}.`,
    );
  }
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
