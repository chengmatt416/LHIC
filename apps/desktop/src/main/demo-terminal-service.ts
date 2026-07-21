import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { DemoCodexRunStatus } from "../shared/contracts.js";

import { resolveCodexExecutable } from "./mcp-service.js";

const execFileAsync = promisify(execFile);

export interface DemoTerminalRunner {
  run(script: string, argumentsList: string[]): Promise<void>;
}

export class DemoTerminalService {
  private codexCompletionPath: string | undefined;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly runner: DemoTerminalRunner = new AppleScriptTerminalRunner(),
  ) {}

  public async launchCodex(
    prompt: string,
    model = "gpt-5.6-luna",
    reasoningEffort = "medium",
  ): Promise<string> {
    const executable = await resolveCodexExecutable();
    const completionPath = join(
      tmpdir(),
      `lhic-codex-${process.pid}-${randomUUID()}.status`,
    );
    this.codexCompletionPath = completionPath;
    try {
      await this.runner.run(codexTerminalScript, [
        this.workspaceRoot,
        executable,
        model,
        reasoningEffort,
        prompt,
        completionPath,
      ]);
    } catch (error) {
      this.codexCompletionPath = undefined;
      throw error;
    }
    return executable;
  }

  public async codexRunStatus(): Promise<DemoCodexRunStatus> {
    if (!this.codexCompletionPath) return { status: "idle" };
    try {
      const content = (await readFile(this.codexCompletionPath, "utf8")).trim();
      const exitCode = content.length > 0 ? Number(content) : Number.NaN;
      if (!Number.isInteger(exitCode)) return { status: "running" };
      return {
        status: exitCode === 0 ? "completed" : "failed",
        exitCode,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "running" };
      }
      throw error;
    }
  }

  public async launchFastPathMonitor(commandId: string): Promise<void> {
    await this.runner.run(fastPathTerminalScript, [
      this.workspaceRoot,
      resolve(this.workspaceRoot, ".lhic/task-journal.json"),
      commandId,
    ]);
  }

  public async focus(): Promise<void> {
    await execFileAsync("/usr/bin/open", ["-a", "Terminal"]);
  }
}

class AppleScriptTerminalRunner implements DemoTerminalRunner {
  public async run(script: string, argumentsList: string[]): Promise<void> {
    await execFileAsync("/usr/bin/osascript", [
      "-e",
      script,
      "--",
      ...argumentsList,
    ]);
  }
}

export const codexTerminalScript = `on run argv
  set workspaceRoot to item 1 of argv
  set codexExecutable to item 2 of argv
  set codexModel to item 3 of argv
  set reasoningEffort to item 4 of argv
  set taskPrompt to item 5 of argv
  set completionPath to item 6 of argv
  set effortOverride to "model_reasoning_effort=\\"" & reasoningEffort & "\\""
  set promptPath to do shell script "/usr/bin/mktemp -t lhic-codex-prompt"
  try
    set promptFile to open for access POSIX file promptPath with write permission
    write taskPrompt to promptFile as «class utf8»
    close access promptFile
  on error errorMessage
    try
      close access POSIX file promptPath
    end try
    do shell script "/bin/rm -f " & quoted form of promptPath
    error errorMessage
  end try
  set promptLoader to "taskPrompt=\\"$(/bin/cat " & quoted form of promptPath & ")\\" && /bin/rm -f " & quoted form of promptPath
  set shellCommand to "umask 077; " & promptLoader & " && cd " & quoted form of workspaceRoot & " && clear && " & quoted form of codexExecutable & " --model " & quoted form of codexModel & " --config " & quoted form of effortOverride & " --dangerously-bypass-approvals-and-sandbox --no-alt-screen -C " & quoted form of workspaceRoot & " \\"$taskPrompt\\"; codexStatus=$?; /usr/bin/printf '%s\\n' \\"$codexStatus\\" > " & quoted form of completionPath & "; exit \\"$codexStatus\\""
  tell application "Finder" to set screenBounds to bounds of window of desktop
  tell application "Terminal"
    activate
    do script shellCommand
    set miniaturized of front window to false
    set bounds of front window to screenBounds
  end tell
end run`;

export const fastPathTerminalScript = `on run argv
  set workspaceRoot to item 1 of argv
  set journalPath to item 2 of argv
  set commandId to item 3 of argv
  set monitorCode to "const f=require('node:fs'),p=process.argv[1],id=process.argv[2],r=()=>{try{const x=JSON.parse(f.readFileSync(p,'utf8'));console.clear();console.log('LHIC FAST PATH — LOCAL EXECUTION\\n0 LLM calls · 0 MCP calls · Playwright/CDP + verifier\\n');console.log(JSON.stringify({events:x.events.filter(e=>e.commandId===id),pending:x.pending.filter(e=>e.commandId===id)},null,2))}catch{}};r();f.watchFile(p,{interval:250},r)"
  set shellCommand to "cd " & quoted form of workspaceRoot & " && clear && /usr/bin/env node -e " & quoted form of monitorCode & " " & quoted form of journalPath & " " & quoted form of commandId
  tell application "Finder" to set screenBounds to bounds of window of desktop
  tell application "Terminal"
    activate
    do script shellCommand
    set miniaturized of front window to false
    set bounds of front window to screenBounds
  end tell
end run`;
