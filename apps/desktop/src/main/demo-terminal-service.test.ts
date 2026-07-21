import { describe, expect, it, vi } from "vitest";

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
    ]);
    expect(codexTerminalScript).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(codexTerminalScript).not.toContain("--ask-for-approval");
    expect(codexTerminalScript).not.toContain("--sandbox workspace-write");
    expect(codexTerminalScript).toContain("--no-alt-screen");
    expect(codexTerminalScript).toContain("/usr/bin/mktemp -t lhic-codex-prompt");
    expect(codexTerminalScript).toContain("$(/bin/cat ");
    expect(codexTerminalScript).toContain("/bin/rm -f ");
    expect(codexTerminalScript).toContain('\\"$taskPrompt\\"');
    expect(codexTerminalScript).not.toContain("quoted form of taskPrompt");
  });

  it("shows the model-free Fast Path journal in Terminal", async () => {
    const run = vi.fn<DemoTerminalRunner["run"]>().mockResolvedValue(undefined);
    const service = new DemoTerminalService("/workspace", { run });

    await service.launchFastPathMonitor();

    expect(run).toHaveBeenCalledWith(fastPathTerminalScript, [
      "/workspace",
      "/workspace/.lhic/task-journal.json",
    ]);
    expect(fastPathTerminalScript).toContain("0 LLM calls · 0 MCP calls");
  });
});
