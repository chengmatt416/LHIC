import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve, sep } from "node:path";

import {
  isCodingVerificationCondition,
  type CodingVerificationCondition,
  type CodingVerificationEvidence,
} from "@lhic/schema";
import { redactPII } from "@lhic/trace";

const execFileAsync = promisify(execFile);
const defaultTimeoutMs = 60_000;
const maximumCapturedBytes = 64 * 1024;

export interface CodingVerificationOptions {
  workspaceRoot: string;
  spawn?: typeof execFile;
}

export interface CodingVerificationOutcome {
  evidence: CodingVerificationEvidence;
  passed: boolean;
}

const verifierVersion = "lhic-coding-verifier-v1";

/**
 * Runs an objective coding verification condition. Commands execute with
 * argument arrays (never shell concatenation), enforced timeouts, bounded
 * redacted output, and workspace containment. A result is evidence: receipts
 * may only become `verified` when the required verifier passed with
 * non-empty evidence.
 */
export async function runCodingVerification(
  condition: CodingVerificationCondition,
  options: CodingVerificationOptions,
): Promise<CodingVerificationOutcome> {
  if (!isCodingVerificationCondition(condition)) {
    throw new Error(
      "Refusing to run a malformed coding verification condition.",
    );
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let outcome: {
    result: "pass" | "fail" | "inconclusive";
    reason?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    errorCount?: number;
    warningCount?: number;
  };

  switch (condition.type) {
    case "command":
      outcome = await runCommand(condition, options);
      break;
    case "git_diff":
      outcome = await runGitDiff(condition, options);
      break;
    case "file_hash":
      outcome = await runFileHash(condition, options);
      break;
    case "expected_content":
      outcome = await runExpectedContent(condition, options);
      break;
    case "diagnostics":
      outcome = await runDiagnostics(condition, options);
      break;
  }

  const completedAt = new Date().toISOString();
  const evidence: CodingVerificationEvidence = {
    schemaVersion: "lhic-coding-verification-v1",
    condition,
    verifierVersion,
    workspaceRoot: options.workspaceRoot,
    startedAt,
    completedAt,
    durationMs: Date.now() - startedMs,
    result: outcome.result,
    ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
    ...(outcome.stdout !== undefined
      ? { stdoutSha256: sha256Hex(outcome.stdout) }
      : {}),
    ...(outcome.stderr !== undefined
      ? { stderrSha256: sha256Hex(outcome.stderr) }
      : {}),
    ...(outcome.errorCount !== undefined
      ? { errorCount: outcome.errorCount }
      : {}),
    ...(outcome.warningCount !== undefined
      ? { warningCount: outcome.warningCount }
      : {}),
    ...(outcome.stdout !== undefined && outcome.stdout.length > 0
      ? { excerpt: boundedRedactedExcerpt(outcome.stdout) }
      : {}),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
  return { evidence, passed: outcome.result === "pass" };
}

interface CommandRunOutcome {
  result: "pass" | "fail" | "inconclusive";
  reason?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

async function runCommand(
  condition: Extract<CodingVerificationCondition, { type: "command" }>,
  options: CodingVerificationOptions,
): Promise<CommandRunOutcome> {
  const cwd = condition.cwd
    ? assertInsideWorkspace(options.workspaceRoot, condition.cwd)
    : options.workspaceRoot;
  try {
    const { stdout, stderr } = await execFileAsync(
      condition.argv[0]!,
      condition.argv.slice(1),
      {
        cwd,
        timeout: condition.timeoutMs ?? defaultTimeoutMs,
        maxBuffer: maximumCapturedBytes,
        env: process.env,
      },
    );
    const exitCode = 0;
    return {
      result: exitCode === condition.expectedExitCode ? "pass" : "fail",
      exitCode,
      stdout,
      stderr,
      ...(exitCode !== condition.expectedExitCode
        ? {
            reason: `Expected exit code ${condition.expectedExitCode}, got ${exitCode}.`,
          }
        : {}),
    };
  } catch (error) {
    const failure = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };
    if (failure.killed) {
      return {
        result: "inconclusive",
        reason: "Verification command timed out.",
        stdout: String(failure.stdout ?? ""),
        stderr: String(failure.stderr ?? ""),
      };
    }
    const exitCode =
      typeof failure.code === "number" ? failure.code : undefined;
    if (exitCode === undefined) {
      return {
        result: "inconclusive",
        reason: String(failure.code ?? "verification command could not run"),
        stderr: String(failure.stderr ?? ""),
      };
    }
    return {
      result: exitCode === condition.expectedExitCode ? "pass" : "fail",
      exitCode,
      stdout: String(failure.stdout ?? ""),
      stderr: String(failure.stderr ?? ""),
      ...(exitCode !== condition.expectedExitCode
        ? {
            reason: `Expected exit code ${condition.expectedExitCode}, got ${exitCode}.`,
          }
        : {}),
    };
  }
}

async function runGitDiff(
  condition: Extract<CodingVerificationCondition, { type: "git_diff" }>,
  options: CodingVerificationOptions,
): Promise<{
  result: "pass" | "fail";
  stdout?: string;
  stderr?: string;
  reason?: string;
}> {
  try {
    const tracked = await execFileAsync(
      "git",
      ["diff", "--name-only", "HEAD"],
      {
        cwd: options.workspaceRoot,
        timeout: defaultTimeoutMs,
        maxBuffer: maximumCapturedBytes,
      },
    );
    const untracked = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard"],
      {
        cwd: options.workspaceRoot,
        timeout: defaultTimeoutMs,
        maxBuffer: maximumCapturedBytes,
      },
    );
    const changed = new Set(
      `${tracked.stdout}\n${untracked.stdout}`
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const stdout = [...changed].join("\n");
    if (
      condition.maxChangedFiles !== undefined &&
      changed.size > condition.maxChangedFiles
    ) {
      return {
        result: "fail",
        stdout,
        reason: `${changed.size} changed files exceeds the limit of ${condition.maxChangedFiles}.`,
      };
    }
    for (const path of changed) {
      if (
        condition.forbiddenPaths?.some(
          (forbidden) =>
            path === forbidden || path.startsWith(`${forbidden}${sep}`),
        )
      ) {
        return {
          result: "fail",
          stdout,
          reason: `Forbidden path changed: ${path}.`,
        };
      }
      const allowed = condition.allowedPaths.some(
        (allowedPath) =>
          path === allowedPath || path.startsWith(`${allowedPath}${sep}`),
      );
      if (!allowed) {
        return {
          result: "fail",
          stdout,
          reason: `Changed path outside allowed scope: ${path}.`,
        };
      }
    }
    return { result: "pass", stdout };
  } catch (error) {
    return {
      result: "fail",
      reason: `git diff failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function runFileHash(
  condition: Extract<CodingVerificationCondition, { type: "file_hash" }>,
  options: CodingVerificationOptions,
): Promise<{
  result: "pass" | "fail";
  reason?: string;
}> {
  const path = assertInsideWorkspace(options.workspaceRoot, condition.path);
  try {
    const actual = sha256Hex(await readFile(path));
    return actual === condition.sha256
      ? { result: "pass" }
      : {
          result: "fail",
          reason: `File hash mismatch for ${condition.path}: expected ${condition.sha256}, got ${actual}.`,
        };
  } catch (error) {
    return {
      result: "fail",
      reason: `Cannot read ${condition.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function runExpectedContent(
  condition: Extract<CodingVerificationCondition, { type: "expected_content" }>,
  options: CodingVerificationOptions,
): Promise<{
  result: "pass" | "fail";
  reason?: string;
}> {
  const path = assertInsideWorkspace(options.workspaceRoot, condition.path);
  try {
    const content = await readFile(path, "utf8");
    return content.includes(condition.matcher)
      ? { result: "pass" }
      : {
          result: "fail",
          reason: `Expected content "${condition.matcher}" not found in ${condition.path}.`,
        };
  } catch (error) {
    return {
      result: "fail",
      reason: `Cannot read ${condition.path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function runDiagnostics(
  condition: Extract<CodingVerificationCondition, { type: "diagnostics" }>,
  options: CodingVerificationOptions,
): Promise<{
  result: "pass" | "fail" | "inconclusive";
  reason?: string;
  errorCount?: number;
  warningCount?: number;
  stdout?: string;
  stderr?: string;
}> {
  if (!condition.argv) {
    return {
      result: "inconclusive",
      reason: "Diagnostics verification requires a diagnostics command (argv).",
    };
  }
  const executed = await runCommand(
    {
      type: "command",
      argv: condition.argv,
      expectedExitCode: 0,
      ...(condition.timeoutMs !== undefined
        ? { timeoutMs: condition.timeoutMs }
        : {}),
    },
    options,
  );
  const output = `${executed.stdout ?? ""}\n${executed.stderr ?? ""}`;
  const errorCount = countMatchingLines(output, /\berror\b/i);
  const warningCount = countMatchingLines(output, /\bwarning\b/i);
  const errorsExceeded = errorCount > condition.maxErrors;
  const warningsExceeded =
    condition.maxWarnings !== undefined && warningCount > condition.maxWarnings;
  return {
    result: errorsExceeded || warningsExceeded ? "fail" : "pass",
    ...(errorsExceeded
      ? {
          reason: `${errorCount} errors exceeds the limit of ${condition.maxErrors}.`,
        }
      : warningsExceeded
        ? {
            reason: `${warningCount} warnings exceeds the limit of ${condition.maxWarnings}.`,
          }
        : {}),
    errorCount,
    warningCount,
    ...(executed.stdout !== undefined ? { stdout: executed.stdout } : {}),
    ...(executed.stderr !== undefined ? { stderr: executed.stderr } : {}),
  };
}

function countMatchingLines(text: string, pattern: RegExp): number {
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

function assertInsideWorkspace(workspaceRoot: string, path: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Path escapes the workspace: ${path}`);
  }
  return target;
}

function boundedRedactedExcerpt(output: string): string {
  const bounded = output.slice(0, 2_000);
  const redacted = redactPII(bounded);
  return typeof redacted === "string" ? redacted : bounded;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
