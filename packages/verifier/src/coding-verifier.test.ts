import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCodingVerification } from "./coding-verifier.js";

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("coding verifier adapters", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-coding-verify-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("passes a command with the expected exit code", async () => {
    const outcome = await runCodingVerification(
      {
        type: "command",
        argv: ["node", "-e", "process.exit(0)"],
        expectedExitCode: 0,
      },
      { workspaceRoot: directory },
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.evidence.result).toBe("pass");
    expect(outcome.evidence.stdoutSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.evidence.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("fails a command with a mismatched exit code", async () => {
    const outcome = await runCodingVerification(
      {
        type: "command",
        argv: ["node", "-e", "process.exit(3)"],
        expectedExitCode: 0,
      },
      { workspaceRoot: directory },
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.evidence.result).toBe("fail");
    expect(outcome.evidence.reason).toMatch(/Expected exit code 0, got 3/);
  });

  it("returns inconclusive on timeout and fails on malformed conditions", async () => {
    // Integration test deliberately exercising the child-process timeout
    // against the platform clock: 50ms << the 5s child sleep, deterministic.
    const timeout = await runCodingVerification(
      {
        type: "command",
        argv: ["node", "-e", "setTimeout(() => {}, 5000)"],
        expectedExitCode: 0,
        timeoutMs: 50,
      },
      { workspaceRoot: directory },
    );
    expect(timeout.evidence.result).toBe("inconclusive");
    expect(timeout.evidence.reason).toMatch(/timed out/);
    await expect(
      runCodingVerification(
        { type: "command", argv: [], expectedExitCode: 0 } as never,
        { workspaceRoot: directory },
      ),
    ).rejects.toThrow(/malformed coding verification/);
  });

  it("enforces git diff constraints", async () => {
    const run = (command: string) =>
      runCodingVerification(
        { type: "command", argv: ["sh", "-c", command], expectedExitCode: 0 },
        { workspaceRoot: directory },
      );
    await run(
      "git init -q && git config user.email t@t && git config user.name t && mkdir -p src",
    );
    await writeFile(join(directory, "src", "a.ts"), "export const a = 1;\n");
    await run("git add src/a.ts && git commit -qm init");
    await writeFile(join(directory, "src", "a.ts"), "export const a = 2;\n");
    const allowed = await runCodingVerification(
      {
        type: "git_diff",
        allowedPaths: ["src"],
        forbiddenPaths: ["src/forbidden.ts"],
        maxChangedFiles: 1,
      },
      { workspaceRoot: directory },
    );
    expect(allowed.passed).toBe(true);
    // Touching a forbidden path fails.
    await writeFile(join(directory, "src", "forbidden.ts"), "x\n");
    const forbidden = await runCodingVerification(
      {
        type: "git_diff",
        allowedPaths: ["src"],
        forbiddenPaths: ["src/forbidden.ts"],
      },
      { workspaceRoot: directory },
    );
    expect(forbidden.passed).toBe(false);
    expect(forbidden.evidence.reason).toMatch(/Forbidden path/);
    // A path outside allowed scope fails.
    await writeFile(join(directory, "other.ts"), "x\n");
    const outside = await runCodingVerification(
      { type: "git_diff", allowedPaths: ["src"] },
      { workspaceRoot: directory },
    );
    expect(outside.passed).toBe(false);
    expect(outside.evidence.reason).toMatch(/outside allowed scope/);
  });

  it("verifies file hashes and expected content", async () => {
    await mkdir(join(directory, "lib"), { recursive: true });
    await writeFile(
      join(directory, "lib", "util.ts"),
      "export const util = 42;\n",
    );
    const hash = await runCodingVerification(
      {
        type: "file_hash",
        path: "lib/util.ts",
        sha256: sha256("export const util = 42;\n"),
      },
      { workspaceRoot: directory },
    );
    expect(hash.passed).toBe(true);
    const changed = await runCodingVerification(
      { type: "file_hash", path: "lib/util.ts", sha256: sha256("different") },
      { workspaceRoot: directory },
    );
    expect(changed.passed).toBe(false);
    expect(changed.evidence.reason).toMatch(/File hash mismatch/);
    const content = await runCodingVerification(
      { type: "expected_content", path: "lib/util.ts", matcher: "util = 42" },
      { workspaceRoot: directory },
    );
    expect(content.passed).toBe(true);
    const missing = await runCodingVerification(
      { type: "expected_content", path: "lib/util.ts", matcher: "nope" },
      { workspaceRoot: directory },
    );
    expect(missing.passed).toBe(false);
  });

  it("rejects paths that escape the workspace", async () => {
    await expect(
      runCodingVerification(
        { type: "file_hash", path: "../outside.txt", sha256: "a".repeat(64) },
        { workspaceRoot: directory },
      ),
    ).rejects.toThrow(/escapes the workspace/);
    await expect(
      runCodingVerification(
        {
          type: "command",
          argv: ["node", "-e", ""],
          expectedExitCode: 0,
          cwd: "../",
        },
        { workspaceRoot: directory },
      ),
    ).rejects.toThrow(/escapes the workspace/);
  });

  it("counts diagnostics errors and warnings", async () => {
    const script = [
      "console.log('error: broken thing');",
      "console.log('warning: deprecated call');",
      "console.log('ok');",
    ].join("");
    const outcome = await runCodingVerification(
      {
        type: "diagnostics",
        maxErrors: 0,
        maxWarnings: 1,
        argv: ["node", "-e", script],
      },
      { workspaceRoot: directory },
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.evidence.errorCount).toBe(1);
    expect(outcome.evidence.warningCount).toBe(1);
    const clean = await runCodingVerification(
      {
        type: "diagnostics",
        maxErrors: 1,
        maxWarnings: 1,
        argv: ["node", "-e", script],
      },
      { workspaceRoot: directory },
    );
    expect(clean.passed).toBe(true);
    const noCommand = await runCodingVerification(
      { type: "diagnostics", maxErrors: 0 },
      { workspaceRoot: directory },
    );
    expect(noCommand.evidence.result).toBe("inconclusive");
  });

  it("bounded output never contains full logs", async () => {
    const big = `node -e "process.stdout.write('x'.repeat(200000))"`;
    const outcome = await runCodingVerification(
      { type: "command", argv: ["sh", "-c", big], expectedExitCode: 0 },
      { workspaceRoot: directory },
    );
    // The capture cap makes huge output fail or truncate — either way the
    // evidence excerpt stays bounded and never contains the full stream.
    expect(outcome.evidence.excerpt?.length ?? 0).toBeLessThanOrEqual(2_000);
    if (outcome.evidence.stdoutSha256 !== undefined) {
      expect(outcome.evidence.stdoutSha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
