import type { HumanIntentCorrectionSubmission } from "../shared/contracts.js";

const maximumSubmissionBytes = 512 * 1_024;
const maximumJsonDepth = 24;
const maximumJsonNodes = 8_192;
const maximumContainerEntries = 1_024;
const controllerStages = new Set([
  "login",
  "form_filling",
  "search",
  "download",
  "test_web_flow",
  "unknown",
]);
const riskLevels = new Set(["low", "medium", "high", "unknown"]);
const uiSurfaces = new Set(["browser", "desktop", "filesystem", "unknown"]);
const uiObjectSources = new Set([
  "dom",
  "accessibility",
  "ocr",
  "vision",
  "api",
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
  assertJsonComplexity(parsed);

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

  validateIntent(binding.intent);
  validateUiState(binding.uiState);
  validateVerification(binding.verification);
  return submission as unknown as HumanIntentCorrectionSubmission;
}

function assertJsonComplexity(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > maximumJsonNodes) {
      throw new Error(
        "Human Intent correction submission has too many values.",
      );
    }
    if (current.depth > maximumJsonDepth) {
      throw new Error(
        "Human Intent correction submission is nested too deeply.",
      );
    }
    if (!current.value || typeof current.value !== "object") continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    if (children.length > maximumContainerEntries) {
      throw new Error(
        "Human Intent correction submission contains an oversized container.",
      );
    }
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function validateIntent(value: unknown): void {
  const intent = requiredRecord(value, "correction intent");
  assertAllowedKeys(
    intent,
    [
      "goal",
      "domain",
      "constraints",
      "riskLevel",
      "requiresConfirmation",
      "missingInformation",
    ],
    "correction intent",
  );
  requiredBoundedString(intent.goal, "correction intent goal", 4_096);
  optionalBoundedString(intent.domain, "correction intent domain", 256);
  const constraints = requiredRecord(
    intent.constraints,
    "correction intent constraints",
  );
  if (Object.keys(constraints).length > 64) {
    throw new Error("correction intent constraints contain too many fields.");
  }
  if (
    typeof intent.riskLevel !== "string" ||
    !riskLevels.has(intent.riskLevel)
  ) {
    throw new Error("correction intent risk level is invalid.");
  }
  if (typeof intent.requiresConfirmation !== "boolean") {
    throw new Error("correction intent confirmation flag is invalid.");
  }
  if (
    !Array.isArray(intent.missingInformation) ||
    intent.missingInformation.length > 32 ||
    !intent.missingInformation.every(
      (item) => typeof item === "string" && item.length <= 1_024,
    )
  ) {
    throw new Error("correction intent missing-information list is invalid.");
  }
}

function validateUiState(value: unknown): void {
  const uiState = requiredRecord(value, "correction UI state");
  assertAllowedKeys(
    uiState,
    [
      "surface",
      "app",
      "url",
      "title",
      "screenType",
      "objects",
      "signals",
      "capturedAt",
    ],
    "correction UI state",
  );
  if (typeof uiState.surface !== "string" || !uiSurfaces.has(uiState.surface)) {
    throw new Error("correction UI surface is invalid.");
  }
  optionalBoundedString(uiState.app, "correction UI app", 256);
  optionalBoundedString(uiState.url, "correction UI URL", 4_096);
  optionalBoundedString(uiState.title, "correction UI title", 1_024);
  optionalBoundedString(uiState.screenType, "correction UI screen type", 256);
  const capturedAt = requiredBoundedString(
    uiState.capturedAt,
    "correction UI capture timestamp",
    64,
  );
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new Error("correction UI capture timestamp is invalid.");
  }
  if (
    !Array.isArray(uiState.objects) ||
    uiState.objects.length > 256 ||
    !isRecord(uiState.signals)
  ) {
    throw new Error("correction UI state is invalid.");
  }
  for (const objectValue of uiState.objects) validateUiObject(objectValue);
}

function validateUiObject(value: unknown): void {
  const object = requiredRecord(value, "correction UI object");
  assertAllowedKeys(
    object,
    [
      "id",
      "role",
      "label",
      "value",
      "enabled",
      "focused",
      "source",
      "selector",
      "ref",
      "bbox",
    ],
    "correction UI object",
  );
  requiredBoundedString(object.id, "correction UI object ID", 512);
  optionalBoundedString(object.role, "correction UI object role", 64);
  optionalBoundedString(object.label, "correction UI object label", 1_024);
  optionalBoundedString(object.value, "correction UI object value", 4_096);
  optionalBoundedString(
    object.selector,
    "correction UI object selector",
    1_024,
  );
  optionalBoundedString(object.ref, "correction UI object reference", 512);
  if (
    typeof object.source !== "string" ||
    !uiObjectSources.has(object.source)
  ) {
    throw new Error("correction UI object source is invalid.");
  }
  if (object.enabled !== undefined && typeof object.enabled !== "boolean") {
    throw new Error("correction UI object enabled flag is invalid.");
  }
  if (object.focused !== undefined && typeof object.focused !== "boolean") {
    throw new Error("correction UI object focused flag is invalid.");
  }
  if (
    object.bbox !== undefined &&
    (!Array.isArray(object.bbox) ||
      object.bbox.length !== 4 ||
      !object.bbox.every(Number.isFinite))
  ) {
    throw new Error("correction UI object bounds are invalid.");
  }
}

function validateVerification(value: unknown): void {
  const verification = requiredRecord(value, "correction verification");
  assertAllowedKeys(
    verification,
    ["success", "evidence", "error"],
    "correction verification",
  );
  optionalBoundedString(
    verification.error,
    "correction verification error",
    4_096,
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

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
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

function optionalBoundedString(
  value: unknown,
  name: string,
  maximumLength: number,
): void {
  if (value === undefined) return;
  requiredBoundedString(value, name, maximumLength);
}
