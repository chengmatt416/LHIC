/**
 * Objective coding verification conditions and results. Verification is
 * evidence: a receipt may only become `verified` when a verifier ran and its
 * evidence refs are attached. Commands always execute with argument arrays
 * (never shell concatenation), enforced timeouts, and bounded output.
 */
export type CodingVerificationCondition =
  | {
      type: "command";
      argv: string[];
      expectedExitCode: number;
      cwd?: string;
      timeoutMs?: number;
    }
  | {
      type: "git_diff";
      allowedPaths: string[];
      forbiddenPaths?: string[];
      maxChangedFiles?: number;
    }
  | {
      type: "file_hash";
      path: string;
      sha256: string;
    }
  | {
      type: "expected_content";
      path: string;
      matcher: string;
    }
  | {
      type: "diagnostics";
      maxErrors: number;
      maxWarnings?: number;
      /** Optional command producing the diagnostics (argument array). */
      argv?: string[];
      timeoutMs?: number;
    };

export interface CodingVerificationEvidence {
  schemaVersion: "lhic-coding-verification-v1";
  condition: CodingVerificationCondition;
  verifierVersion: string;
  workspaceRoot: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  result: "pass" | "fail" | "inconclusive";
  exitCode?: number;
  stdoutSha256?: string;
  stderrSha256?: string;
  /** Bounded, redacted output excerpt (never full logs, never secrets). */
  excerpt?: string;
  errorCount?: number;
  warningCount?: number;
  inputHashes?: string[];
  reason?: string;
}

export function isCodingVerificationCondition(
  value: unknown,
): value is CodingVerificationCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const condition = value as Record<string, unknown>;
  switch (condition.type) {
    case "command":
      return (
        Array.isArray(condition.argv) &&
        condition.argv.every((arg) => typeof arg === "string") &&
        condition.argv.length > 0 &&
        typeof condition.expectedExitCode === "number" &&
        (condition.cwd === undefined || typeof condition.cwd === "string") &&
        (condition.timeoutMs === undefined ||
          (typeof condition.timeoutMs === "number" && condition.timeoutMs > 0))
      );
    case "git_diff":
      return (
        Array.isArray(condition.allowedPaths) &&
        condition.allowedPaths.every((path) => typeof path === "string") &&
        (condition.forbiddenPaths === undefined ||
          (Array.isArray(condition.forbiddenPaths) &&
            condition.forbiddenPaths.every(
              (path) => typeof path === "string",
            ))) &&
        (condition.maxChangedFiles === undefined ||
          (typeof condition.maxChangedFiles === "number" &&
            Number.isSafeInteger(condition.maxChangedFiles) &&
            condition.maxChangedFiles > 0))
      );
    case "file_hash":
      return (
        typeof condition.path === "string" &&
        condition.path.length > 0 &&
        typeof condition.sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(condition.sha256)
      );
    case "expected_content":
      return (
        typeof condition.path === "string" &&
        condition.path.length > 0 &&
        typeof condition.matcher === "string"
      );
    case "diagnostics":
      return (
        typeof condition.maxErrors === "number" &&
        Number.isSafeInteger(condition.maxErrors) &&
        condition.maxErrors >= 0 &&
        (condition.maxWarnings === undefined ||
          (typeof condition.maxWarnings === "number" &&
            Number.isSafeInteger(condition.maxWarnings) &&
            condition.maxWarnings >= 0)) &&
        (condition.argv === undefined ||
          (Array.isArray(condition.argv) &&
            condition.argv.every((arg) => typeof arg === "string") &&
            condition.argv.length > 0)) &&
        (condition.timeoutMs === undefined ||
          (typeof condition.timeoutMs === "number" && condition.timeoutMs > 0))
      );
    default:
      return false;
  }
}

export function isCodingVerificationEvidence(
  value: unknown,
): value is CodingVerificationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (evidence.schemaVersion !== "lhic-coding-verification-v1") return false;
  if (!isCodingVerificationCondition(evidence.condition)) return false;
  if (typeof evidence.verifierVersion !== "string") return false;
  if (typeof evidence.workspaceRoot !== "string") return false;
  if (
    typeof evidence.startedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.startedAt)) ||
    typeof evidence.completedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.completedAt))
  ) {
    return false;
  }
  if (typeof evidence.durationMs !== "number") return false;
  if (!["pass", "fail", "inconclusive"].includes(String(evidence.result))) {
    return false;
  }
  return true;
}
