import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runActionFile } from "./run-action.js";

describe("runActionFile", () => {
  it("runs a low-risk action through the production executor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-run-action-"));
    const actionPath = join(directory, "press.json");
    try {
      await writeFile(
        actionPath,
        JSON.stringify({
          type: "press",
          intent: "trigger a low-risk keyboard event",
          value: "Enter",
          methodPreference: ["keyboard"],
          riskLevel: "low",
        }),
      );

      const result = await runActionFile(actionPath, undefined, {
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
});
