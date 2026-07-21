import { describe, expect, it, vi } from "vitest";
import { unlink, writeFile } from "node:fs/promises";

import {
  codexTerminalScript,
  DemoTerminalService,
  fastPathTerminalScript,
  type DemoTerminalRunner,
} from "./demo-terminal-service.js";

describe("DemoTerminalService", () => {
  it("launches Codex CLI with Luna at medium reasoning and the approved prompt", async () => {
    const run = vi.fn<DemoTerminalRunner["run"]>().mockResolvedValue(undefined);
    const service = new DemoTerminalService("/workspace", { run });

    await service.launchCodex("Use only LHIC MCP.");

    expect(run).toHaveBeenCalledWith(codexTerminalScript, [
      "/workspace",
      expect.stringMatching(/codex$/),
      "gpt-5.6-luna",
      "medium",
      "Use only LHIC MCP.",
      expect.stringMatching(/lhic-codex-.+\.status$/),
    ]);
    expect(codexTerminalScript).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(codexTerminalScript).not.toContain("--ask-for-approval");
    expect(codexTerminalScript).not.toContain("--sandbox workspace-write");
    expect(codexTerminalScript).toContain("--no-alt-screen");
    expect(codexTerminalScript).toContain(
      "/usr/bin/mktemp -t lhic-codex-prompt",
    );
    expect(codexTerminalScript).toContain("$(/bin/cat ");
    expect(codexTerminalScript).toContain("/bin/rm -f ");
    expect(codexTerminalScript).toContain('\\"$taskPrompt\\"');
    expect(codexTerminalScript).not.toContain("quoted form of taskPrompt");
    expect(codexTerminalScript).toContain("codexStatus=$?");
    expect(codexTerminalScript).toContain("quoted form of completionPath");
  });

  it("reports the real Codex CLI exit status to the portal", async () => {
    const run = vi.fn<DemoTerminalRunner["run"]>().mockResolvedValue(undefined);
    const service = new DemoTerminalService("/workspace", { run });

    expect(await service.codexRunStatus()).toEqual({ status: "idle" });
    await service.launchCodex("Use only LHIC MCP.");
    const completionPath = run.mock.calls[0]?.[1][5];
    expect(completionPath).toBeTypeOf("string");

    try {
      expect(await service.codexRunStatus()).toEqual({ status: "running" });
      await writeFile(completionPath!, "0\n", { mode: 0o600 });
      expect(await service.codexRunStatus()).toEqual({
        status: "completed",
        exitCode: 0,
      });
      await writeFile(completionPath!, "7\n", { mode: 0o600 });
      expect(await service.codexRunStatus()).toEqual({
        status: "failed",
        exitCode: 7,
      });
    } finally {
      await unlink(completionPath!).catch(() => undefined);
    }
  });

  it("shows the model-free Fast Path journal in Terminal", async () => {
    const run = vi.fn<DemoTerminalRunner["run"]>().mockResolvedValue(undefined);
    const service = new DemoTerminalService("/workspace", { run });

    await service.launchFastPathMonitor("fast-command-1");

    expect(run).toHaveBeenCalledWith(fastPathTerminalScript, [
      "/workspace",
      "/workspace/.lhic/task-journal.json",
      "fast-command-1",
    ]);
    expect(fastPathTerminalScript).toContain("0 LLM calls · 0 MCP calls");
    expect(fastPathTerminalScript).toContain("filter(e=>e.commandId===id)");
    expect(fastPathTerminalScript).not.toContain("tail -n");
  });
});
