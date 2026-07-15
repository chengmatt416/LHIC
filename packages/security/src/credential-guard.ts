import { redactSensitiveData } from "./pii-redaction.js";

export interface CredentialGuardResult<T> {
  safe: T;
  containsCredentials: boolean;
}

const credentialKeyPattern =
  /(password|passphrase|pwd|token|secret|api[_-]?key|authorization|cookie)/i;

export function guardCredentials<T>(input: T): CredentialGuardResult<T> {
  const containsCredentials = containsSensitiveKey(input);
  return { safe: redactSensitiveData(input), containsCredentials };
}

export function containsSensitiveKey(input: unknown): boolean {
  if (Array.isArray(input)) {
    return input.some(containsSensitiveKey);
  }
  if (!input || typeof input !== "object") {
    return false;
  }

  return Object.entries(input as Record<string, unknown>).some(
    ([key, value]) =>
      credentialKeyPattern.test(key) || containsSensitiveKey(value),
  );
}
