import {
  isGlobalComputerAction,
  type SemanticAction,
  type RiskLevel,
} from "@lhic/schema";

export interface RiskDecision {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason: string;
}

export interface RiskPolicyOptions {
  allowCustom?: boolean;
}

const destructiveIntentPattern =
  /\b(delete|remove|destroy|pay|purchase|send(?:[_\s]+external)?[_\s]+email|production[_\s-]?write|transfer)\b/i;
const sideEffectActivationTargetPattern =
  /\b(delete|remove|destroy|pay|purchase|send|production[_\s-]?write|transfer|submit|save|confirm|apply|checkout|order|publish|approve)\b/i;

type RiskEvaluatedAction = Pick<
  SemanticAction,
  "type" | "intent" | "riskLevel" | "target"
>;

export function classifyActionRisk(
  action: Pick<SemanticAction, "type" | "intent" | "riskLevel" | "target">,
): RiskLevel {
  return isDestructiveAction(action) ? "high" : action.riskLevel;
}

export function evaluateRisk(
  action: RiskEvaluatedAction,
  options: RiskPolicyOptions = {},
): RiskDecision {
  const riskLevel = classifyActionRisk(action);

  if (riskLevel === "high") {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "High-risk actions require human confirmation.",
    };
  }

  if (riskLevel === "unknown") {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Unknown-risk actions require human confirmation.",
    };
  }

  if (action.type === "custom" && !options.allowCustom) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Custom actions require human confirmation.",
    };
  }

  return {
    allowed: true,
    requiresConfirmation: false,
    reason: "Action is permitted by the local risk policy.",
  };
}

function isDestructiveAction(action: RiskEvaluatedAction): boolean {
  if (destructiveIntentPattern.test(action.intent)) {
    return true;
  }
  return (
    (action.type === "click" || action.type === "press") &&
    isSideEffectActivationTarget(action.target ?? "")
  );
}

export function isSideEffectActivationTarget(target: string): boolean {
  return sideEffectActivationTargetPattern.test(target);
}

/**
 * Unified approval check used by both MultiPathTaskController and
 * BrowserPlanRunner. Returns a reason string if approval is required,
 * or undefined if the action can proceed without approval.
 */
export function actionRequiresApproval(
  action: SemanticAction,
  options: { requireActivationApproval?: boolean } = {},
): string | undefined {
  if (isGlobalComputerAction(action)) {
    return "Global desktop actions require explicit human approval.";
  }
  const policy = evaluateRisk(action);
  if (policy.requiresConfirmation) {
    return policy.reason;
  }
  if (action.riskLevel !== "low") {
    return policy.reason;
  }
  if (
    options.requireActivationApproval &&
    (action.type === "click" ||
      action.type === "press" ||
      action.type === "download")
  ) {
    return "Activation approval required for click/press/download actions.";
  }
  return undefined;
}
