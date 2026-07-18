import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GlobalComputerAction } from "@lhic/schema";
import { createActionApproval } from "@lhic/security";
import { describe, expect, it } from "vitest";

import {
  buildGlobalComputerCommand,
  GlobalComputerExecutor,
  type GlobalCommand,
  type GlobalCommandResult,
  type GlobalCommandRunner,
} from "./os-bridge.js";

class RecordingRunner implements GlobalCommandRunner {
  public readonly commands: GlobalCommand[] = [];

  public async run(command: GlobalCommand): Promise<GlobalCommandResult> {
    this.commands.push(command);
    if (
      command.file === "osascript" &&
      command.args[1]?.includes("frontmost")
    ) {
      return { stdout: "TextEdit\tUntitled\n", stderr: "" };
    }
    if (command.file === "pgrep") {
      return { stdout: "321\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }
}

function typeAction(text = "approved text"): GlobalComputerAction {
  return {
    scope: "os",
    type: "os_type",
    intent: "type the approved value into the editor",
    methodPreference: ["keyboard"],
    riskLevel: "high",
    text,
    verifier: { type: "active_window", application: "TextEdit" },
  };
}

describe("GlobalComputerExecutor", () => {
  it("uses argument-based native macOS input and records verifier evidence", async () => {
    const action = typeAction('"; do shell script "unexpected"');
    const runner = new RecordingRunner();
    const executor = new GlobalComputerExecutor({
      platform: "darwin",
      runner,
      traceFilePath: join(tmpdir(), "lhic-global-test-trace.jsonl"),
    });

    const result = await executor.execute(
      action,
      createActionApproval(action, "local-operator"),
    );

    expect(result).toMatchObject({
      success: true,
      method: "keyboard",
      evidence: [
        expect.stringContaining("os_type"),
        "Verified active application against the requested verifier.",
      ],
    });
    expect(runner.commands[0]).toEqual({
      file: "osascript",
      args: expect.arrayContaining([action.text]),
    });
    expect(runner.commands[0]?.args[1]).not.toContain(action.text);
  });

  it("does not dispatch an unapproved global action", async () => {
    const runner = new RecordingRunner();
    const executor = new GlobalComputerExecutor({ platform: "darwin", runner });

    const result = await executor.execute(typeAction());

    expect(result.success).toBe(false);
    expect(result.error).toContain("approval");
    expect(runner.commands).toEqual([]);
  });

  it("verifies a launched Linux application is running", async () => {
    const action: GlobalComputerAction = {
      scope: "os",
      type: "os_launch",
      intent: "launch the approved terminal application",
      methodPreference: ["accessibility"],
      riskLevel: "high",
      application: "org.gnome.Terminal",
      verifier: { type: "process_running", application: "gnome-terminal" },
    };
    const runner = new RecordingRunner();
    const executor = new GlobalComputerExecutor({ platform: "linux", runner });

    const result = await executor.execute(
      action,
      createActionApproval(action, "local-operator"),
    );

    expect(result.success).toBe(true);
    expect(runner.commands).toEqual([
      { file: "gtk-launch", args: ["org.gnome.Terminal"] },
      { file: "pgrep", args: ["-if", "gnome-terminal"] },
    ]);
  });

  it("does not embed typed text in the Windows PowerShell source", () => {
    const action = typeAction("do-not-put-this-in-powershell-source");

    const command = buildGlobalComputerCommand(action, "win32");

    expect(command.file).toBe("powershell.exe");
    expect(command.args).toContain("-EncodedCommand");
    expect(command.args.join(" ")).not.toContain(action.text);
  });

  it("redacts typed text from the persisted trace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-global-trace-"));
    const traceFilePath = join(directory, "trace.jsonl");
    const action = typeAction("do-not-persist-this-text");
    const runner = new RecordingRunner();
    const executor = new GlobalComputerExecutor({
      platform: "darwin",
      runner,
      traceFilePath,
    });

    try {
      await executor.execute(action, createActionApproval(action, "operator"));
      const trace = await readFile(traceFilePath, "utf8");
      expect(trace).not.toContain(action.text);
      expect(trace).toContain("global_action_completed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("dispatches accessibility clicks on macOS", () => {
    const action: GlobalComputerAction = {
      scope: "os",
      type: "os_click",
      intent: "click the button",
      methodPreference: ["accessibility"],
      riskLevel: "high",
      application: "Safari",
      target: "Submit",
      verifier: { type: "active_window", application: "Safari" },
    };
    const command = buildGlobalComputerCommand(action, "darwin");
    expect(command.file).toBe("osascript");
    expect(command.args[1]).toContain("tell process (item 1 of argv)");
    expect(command.args[3]).toBe("Safari");
    expect(command.args[4]).toBe("Submit");
  });

  it("dispatches accessibility clicks on Windows", () => {
    const action: GlobalComputerAction = {
      scope: "os",
      type: "os_click",
      intent: "click the button",
      methodPreference: ["accessibility"],
      riskLevel: "high",
      application: "chrome",
      target: "Submit",
      verifier: { type: "active_window", application: "chrome" },
    };
    const command = buildGlobalComputerCommand(action, "win32");
    expect(command.file).toBe("powershell.exe");
    expect(command.args).toContain("-EncodedCommand");
  });
});
