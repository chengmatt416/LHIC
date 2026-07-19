import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createActionApproval } from "@lhic/security";

import { runActionFile } from "./run-action.js";

describe("runActionFile", () => {
  it("runs an approved focus-sensitive action through the production executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-action-"));
    const actionPath = join(directory, "press.json");
    const approvalPath = join(directory, "approval.json");
    const action = {
      type: "press" as const,
      intent: "trigger a low-risk keyboard event",
      value: "Enter",
      methodPreference: ["keyboard" as const],
      riskLevel: "low" as const,
    };
    try {
      await writeFile(actionPath, JSON.stringify(action));
      await writeFile(
        approvalPath,
        JSON.stringify(createActionApproval(action, "operator@example.test")),
      );

      const result = await runActionFile(actionPath, approvalPath, {
        LHIC_ENV: "test",
        LHIC_TRACE_DIRECTORY: directory,
      });
      expect(result).toEqual({
        success: true,
        method: "keyboard",
        latencyMs: expect.any(Number),
        evidence: ["Pressed Enter."],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed action files before launching an action", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-action-"));
    const actionPath = join(directory, "invalid.json");
    try {
      await writeFile(actionPath, JSON.stringify({ type: "click" }));
      await expect(runActionFile(actionPath)).rejects.toThrow("SemanticAction");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects action files with an unrecognized risk level", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-action-"));
    const actionPath = join(directory, "invalid-risk.json");
    try {
      await writeFile(
        actionPath,
        JSON.stringify({
          type: "press",
          intent: "continue",
          value: "Enter",
          methodPreference: ["keyboard"],
          riskLevel: "untrusted",
        }),
      );
      await expect(runActionFile(actionPath)).rejects.toThrow("SemanticAction");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes a global action through the approval boundary before native input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-action-"));
    const actionPath = join(directory, "global.json");
    try {
      await writeFile(
        actionPath,
        JSON.stringify({
          scope: "os",
          type: "os_type",
          intent: "type an approved value into the active editor",
          methodPreference: ["keyboard"],
          riskLevel: "high",
          text: "must-not-be-typed-without-approval",
          verifier: { type: "active_window", application: "TextEdit" },
        }),
      );

      const result = await runActionFile(actionPath, undefined, {
        LHIC_ENV: "test",
        LHIC_TRACE_DIRECTORY: directory,
      });

      expect(result).toMatchObject({
        success: false,
        evidence: [],
        error: expect.stringContaining("approval"),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
