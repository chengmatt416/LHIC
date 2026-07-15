import type { RiskLevel } from "./risk.js";

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
  return (
    typeof candidate.goal === "string" &&
    !!candidate.constraints &&
    typeof candidate.constraints === "object" &&
    typeof candidate.requiresConfirmation === "boolean" &&
    Array.isArray(candidate.missingInformation)
  );
}
