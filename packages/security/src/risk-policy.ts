import type { SemanticAction, RiskLevel } from "@lhic/schema";

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

export function classifyActionRisk(
  action: Pick<SemanticAction, "intent" | "riskLevel">,
): RiskLevel {
  return destructiveIntentPattern.test(action.intent)
    ? "high"
    : action.riskLevel;
}

export function evaluateRisk(
  action: Pick<SemanticAction, "type" | "intent" | "riskLevel">,
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
