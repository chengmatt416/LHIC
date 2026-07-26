import type { HumanIntentCorrectionSubmission } from "../shared/contracts.js";

const maximumSubmissionBytes = 512 * 1_024;
const controllerStages = new Set([
  "login",
  "form_filling",
  "search",
  "download",
  "test_web_flow",
  "unknown",
]);

/** Canonicalizes IPC input into a bounded, JSON-only plain object. */
export function validateHumanIntentCorrectionSubmission(
  value: unknown,
): HumanIntentCorrectionSubmission {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Human Intent correction submission is not JSON-safe.");
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized, "utf8") > maximumSubmissionBytes
  ) {
    throw new Error(
      "Human Intent correction submission is empty or too large.",
    );
  }
  const parsed = JSON.parse(serialized) as unknown;
  const submission = requiredRecord(parsed, "correction submission");
  assertExactKeys(submission, ["approval", "binding"], "correction submission");
  const binding = requiredRecord(submission.binding, "correction binding");
  const approval = requiredRecord(submission.approval, "correction approval");
  assertExactKeys(approval, ["claim", "signature"], "correction approval");
  requiredRecord(approval.claim, "correction approval claim");
  requiredBoundedString(approval.signature, "correction signature", 1_024);
  requiredBoundedString(binding.taskId, "correction task ID", 256);
  const trace = requiredBoundedString(
    binding.traceSha256,
    "correction trace SHA-256",
    64,
  );
  if (!/^[a-f0-9]{64}$/.test(trace)) {
    throw new Error("correction trace SHA-256 is invalid.");
  }
  requiredBoundedString(
    binding.verifierVersion,
    "correction verifier version",
    128,
  );
  if (binding.split !== "training" && binding.split !== "validation") {
    throw new Error("correction evidence split is invalid.");
  }
  if (
    typeof binding.predictedStage !== "string" ||
    !controllerStages.has(binding.predictedStage) ||
    typeof binding.correctedStage !== "string" ||
    !controllerStages.has(binding.correctedStage)
  ) {
    throw new Error("correction stage binding is invalid.");
  }
  requiredRecord(binding.intent, "correction intent");
  const uiState = requiredRecord(binding.uiState, "correction UI state");
  if (
    !Array.isArray(uiState.objects) ||
    uiState.objects.length > 256 ||
    !uiState.objects.every(isRecord) ||
    !isRecord(uiState.signals)
  ) {
    throw new Error("correction UI state is invalid.");
  }
  const verification = requiredRecord(
    binding.verification,
    "correction verification",
  );
  if (
    typeof verification.success !== "boolean" ||
    !Array.isArray(verification.evidence) ||
    verification.evidence.length < 1 ||
    verification.evidence.length > 64 ||
    !verification.evidence.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 4_096,
    )
  ) {
    throw new Error("correction verifier evidence is invalid.");
  }
  return submission as unknown as HumanIntentCorrectionSubmission;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    !actual.every((key, index) => key === sortedExpected[index])
  ) {
    throw new Error(`${name} contains unexpected fields.`);
  }
}

function requiredBoundedString(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximumLength
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}
