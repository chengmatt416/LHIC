import {
  isGlobalComputerAction,
  type SemanticAction,
  type RiskLevel,
} from "@lhic/schema";

import {
  inferSideEffectClass,
  isHighRiskSideEffectClass,
} from "./side-effect-classification.js";

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

/**
 * Typed, taxonomy-first risk level: the independently inferred side-effect
 * class is primary (high-risk classes always escalate), keyword patterns are
 * only the conservative backstop. The planner's own label can never lower the
 * result.
 */
export function structuredRiskLevel(action: SemanticAction): RiskLevel {
  const inferred = inferSideEffectClass(action);
  if (isHighRiskSideEffectClass(inferred)) return "high";
  // An unclassifiable action never inherits the planner's label: unknown
  // class means unknown risk, which requires confirmation.
  if (inferred === "unknown") return "unknown";
  return classifyActionRisk(action);
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

/**
 * Structured risk decision used at approval boundaries: the side-effect
 * taxonomy is primary, so a planner-labeled "low risk" purchase/destructive/
 * credential action still requires confirmation.
 */
export function evaluateStructuredRisk(
  action: SemanticAction,
  options: RiskPolicyOptions = {},
): RiskDecision {
  const riskLevel = structuredRiskLevel(action);
  if (riskLevel === "high") {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "High-risk side-effect class requires human confirmation.",
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
    reason: "Action is permitted by the structured side-effect policy.",
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
  if (action.type === "upload") {
    return "Uploading a local file requires explicit human approval.";
  }
  const policy = evaluateStructuredRisk(action);
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
