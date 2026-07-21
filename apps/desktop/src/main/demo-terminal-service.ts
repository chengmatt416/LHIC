import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { resolveCodexExecutable } from "./mcp-service.js";

const execFileAsync = promisify(execFile);

export interface DemoTerminalRunner {
  run(script: string, argumentsList: string[]): Promise<void>;
}

export class DemoTerminalService {
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
    await this.runner.run(codexTerminalScript, [
      this.workspaceRoot,
      executable,
      model,
      reasoningEffort,
      prompt,
    ]);
    return executable;
  }

  public async launchFastPathMonitor(): Promise<void> {
    await this.runner.run(fastPathTerminalScript, [
      this.workspaceRoot,
      resolve(this.workspaceRoot, ".lhic/task-journal.json"),
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
  set shellCommand to promptLoader & " && cd " & quoted form of workspaceRoot & " && clear && exec " & quoted form of codexExecutable & " --model " & quoted form of codexModel & " --config " & quoted form of effortOverride & " --dangerously-bypass-approvals-and-sandbox --no-alt-screen -C " & quoted form of workspaceRoot & " \\"$taskPrompt\\""
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
  set shellCommand to "cd " & quoted form of workspaceRoot & " && clear && echo 'LHIC FAST PATH — LOCAL EXECUTION' && echo '0 LLM calls · 0 MCP calls · Playwright/CDP + verifier' && echo && /usr/bin/tail -n 80 -F " & quoted form of journalPath
  tell application "Finder" to set screenBounds to bounds of window of desktop
  tell application "Terminal"
    activate
    do script shellCommand
    set miniaturized of front window to false
    set bounds of front window to screenBounds
  end tell
end run`;
