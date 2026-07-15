export const riskLevels = ["low", "medium", "high", "unknown"] as const;

export type RiskLevel = (typeof riskLevels)[number];

export function isRiskLevel(value: unknown): value is RiskLevel {
  return (
    typeof value === "string" &&
    (riskLevels as readonly string[]).includes(value)
  );
}
