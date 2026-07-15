const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?<!\w)(?:\+?\d[\d().\-\s]{7,}\d)(?!\w)/g;
const bearerTokenPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const jwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const apiTokenPattern = /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi;
const sensitiveKeyPattern =
  /(password|passphrase|pwd|token|secret|api[_-]?key|authorization|cookie)/i;
const sensitiveFieldHintPattern =
  /(password|passphrase|pwd|token|secret|api[_-]?key|authorization|cookie)/i;

function redactString(value: string): string {
  return value
    .replace(emailPattern, "[REDACTED_EMAIL]")
    .replace(phonePattern, "[REDACTED_PHONE]")
    .replace(bearerTokenPattern, "Bearer [REDACTED_TOKEN]")
    .replace(jwtPattern, "[REDACTED_TOKEN]")
    .replace(apiTokenPattern, "[REDACTED_TOKEN]");
}

export function redactPII<T>(input: T): T {
  if (typeof input === "string") {
    return redactString(input) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactPII(item)) as T;
  }

  if (!input || typeof input !== "object") {
    return input;
  }

  const record = input as Record<string, unknown>;
  const valueBelongsToSensitiveField = Object.entries(record).some(
    ([key, value]) =>
      ["target", "selector", "field", "label", "name"].includes(key) &&
      typeof value === "string" &&
      sensitiveFieldHintPattern.test(value),
  );

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      sensitiveKeyPattern.test(key) ||
      (key === "value" && valueBelongsToSensitiveField)
        ? "[REDACTED]"
        : redactPII(value),
    ]),
  ) as T;
}
