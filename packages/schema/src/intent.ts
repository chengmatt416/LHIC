import { isRiskLevel, type RiskLevel } from "./risk.js";

export interface UserIntent {
  goal: string;
  domain?: string;
  constraints: Record<string, unknown>;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  missingInformation: string[];
}

export function isUserIntent(value: unknown): value is UserIntent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<UserIntent>;
  if (typeof candidate.goal !== "string" || !candidate.goal.trim()) {
    return false;
  }
  if (!candidate.constraints || typeof candidate.constraints !== "object") {
    return false;
  }
  if (!isRiskLevel(candidate.riskLevel)) {
    return false;
  }
  if (typeof candidate.requiresConfirmation !== "boolean") {
    return false;
  }
  if (
    !Array.isArray(candidate.missingInformation) ||
    !candidate.missingInformation.every((v) => typeof v === "string")
  ) {
    return false;
  }
  return true;
}
