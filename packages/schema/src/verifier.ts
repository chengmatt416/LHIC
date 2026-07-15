export const verificationConditionTypes = [
  "dom",
  "url",
  "network",
  "file",
  "screenshot",
  "custom",
] as const;

export type VerificationConditionType =
  (typeof verificationConditionTypes)[number];

export interface VerificationCondition {
  type: VerificationConditionType;
  description: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export interface VerificationResult {
  success: boolean;
  evidence: string[];
  error?: string;
}

export function isVerificationCondition(
  value: unknown,
): value is VerificationCondition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<VerificationCondition>;
  return (
    typeof candidate.type === "string" &&
    (verificationConditionTypes as readonly string[]).includes(
      candidate.type,
    ) &&
    typeof candidate.description === "string" &&
    !!candidate.params &&
    typeof candidate.params === "object"
  );
}
