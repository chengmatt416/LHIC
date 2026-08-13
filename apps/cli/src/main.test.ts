import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isCliEntryPoint, parseAgentCommandOptions } from "./main.js";

describe("isCliEntryPoint", () => {
  it("recognizes the package-manager symlink used for a CLI binary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-cli-entry-"));
    const modulePath = join(directory, "main.js");
    const binaryPath = join(directory, "lhic");
    await writeFile(modulePath, "", "utf8");
    await symlink(modulePath, binaryPath);

    expect(isCliEntryPoint(binaryPath, modulePath)).toBe(true);
  });

  it("does not run for an unrelated or missing executable path", () => {
    expect(isCliEntryPoint(undefined, "/tmp/main.js")).toBe(false);
    expect(isCliEntryPoint("/tmp/lhic-missing", "/tmp/main.js")).toBe(false);
  });
});

describe("parseAgentCommandOptions", () => {
  it("parses one-shot automation flags without mixing them into the prompt", () => {
    expect(
      parseAgentCommandOptions([
        "fix",
        "the",
        "bug",
        "--jsonl",
        "--session",
        "last",
        "--model",
        "openai-codex/gpt-5.6-sol",
        "--thinking",
        "high",
        "--fast",
        "--approval-policy",
        "deny",
        "--subagent-model",
        "openai-codex/gpt-5.6-sol",
        "--subagent-model",
        "google-antigravity/gemini-3.6-flash",
      ]),
    ).toEqual({
      prompt: "fix the bug",
      jsonl: true,
      session: "last",
      model: "openai-codex/gpt-5.6-sol",
      thinking: "high",
      subagentModels: [
        "openai-codex/gpt-5.6-sol",
        "google-antigravity/gemini-3.6-flash",
      ],
      fast: true,
      approvalPolicy: "deny",
    });
  });

  it("rejects malformed and unknown agent flags", () => {
    expect(() => parseAgentCommandOptions(["--jsonl"])).toThrow(
      "requires a one-shot",
    );
    expect(() =>
      parseAgentCommandOptions(["hello", "--approval-policy", "always"]),
    ).toThrow("ask, deny, or auto");
    expect(() => parseAgentCommandOptions(["--mystery"])).toThrow(
      "Unknown agent option",
    );
    expect(() =>
      parseAgentCommandOptions([
        "hello",
        "--subagent-model",
        "none",
        "--subagent-model",
        "openai-codex/gpt-5.6-sol",
      ]),
    ).toThrow("cannot be combined");
    expect(
      parseAgentCommandOptions(["hello", "--subagent-model", "none"])
        .subagentModels,
    ).toEqual([]);
  });
});
