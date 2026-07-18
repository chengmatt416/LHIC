import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { isGlobalComputerAction } from "@lhic/schema";
import type {
  ActionExecutionResult,
  ActionMethod,
  GlobalComputerAction,
  GlobalComputerVerification,
  RiskLevel,
} from "@lhic/schema";
import {
  validateActionApproval,
  type ActionApproval,
  type ActionApprovalValidationOptions,
} from "@lhic/security";
import { appendTraceEvent } from "@lhic/trace";

const execFileAsync = promisify(execFile);

export type GlobalDesktopPlatform = "darwin" | "win32" | "linux";

export interface GlobalCommand {
  file: string;
  args: string[];
}

export interface GlobalCommandResult {
  stdout: string;
  stderr: string;
}

export interface GlobalCommandRunner {
  run(command: GlobalCommand): Promise<GlobalCommandResult>;
}

export interface GlobalDesktopState {
  application: string;
  title?: string;
}

export interface GlobalComputerExecutorOptions {
  taskId?: string;
  traceFilePath?: string;
  platform?: GlobalDesktopPlatform;
  runner?: GlobalCommandRunner;
  approvalValidation?: ActionApprovalValidationOptions;
}

export interface GlobalControlCapability {
  platform: GlobalDesktopPlatform;
  supported: boolean;
  detail: string;
}

/**
 * Executes one approved OS-level action with native platform APIs. Commands
 * are always passed through execFile, never a shell, so user-provided values
 * cannot alter the executable command line.
 */
export class GlobalComputerExecutor {
  private readonly taskId: string;
  private readonly traceFilePath: string;
  private readonly platform: GlobalDesktopPlatform;
  private readonly runner: GlobalCommandRunner;
  private readonly approvalValidation: ActionApprovalValidationOptions;

  public constructor(options: GlobalComputerExecutorOptions = {}) {
    this.taskId = options.taskId ?? "global-computer-session";
    this.traceFilePath =
      options.traceFilePath ?? join("traces", `${this.taskId}.jsonl`);
    this.platform = options.platform ?? getGlobalDesktopPlatform();
    this.runner = options.runner ?? new ExecFileGlobalCommandRunner();
    this.approvalValidation = {
      requireSignature: process.env.LHIC_ENV === "production",
      ...options.approvalValidation,
    };
  }

  public async execute(
    action: GlobalComputerAction,
    approval?: ActionApproval,
  ): Promise<ActionExecutionResult> {
    if (!isGlobalComputerAction(action)) {
      return {
        success: false,
        latencyMs: 0,
        evidence: [],
        error: "Global computer action does not match the required schema.",
      };
    }
    const startedAt = performance.now();
    const method = methodForGlobalAction(action.type);
    await this.trace(
      "global_action_started",
      {
        type: action.type,
        method,
      },
      action.riskLevel,
    );

    try {
      if (!action.methodPreference.includes(method)) {
        throw new Error(
          `Global action ${action.type} does not permit the required ${method} method.`,
        );
      }

      const approvalDecision = validateActionApproval(
        action,
        approval,
        new Date(),
        {
          ...this.approvalValidation,
          forceConfirmation: true,
          confirmationReason:
            "Global computer actions require a matching human approval.",
        },
      );
      if (!approvalDecision.allowed) {
        throw new Error(approvalDecision.reason);
      }

      await this.runner.run(buildGlobalComputerCommand(action, this.platform));
      const verificationEvidence = await this.verify(action.verifier);
      const result: ActionExecutionResult = {
        success: true,
        method,
        latencyMs: Math.round(performance.now() - startedAt),
        evidence: [
          `Dispatched ${action.type} through the ${this.platform} native ${method} API.`,
          verificationEvidence,
        ],
      };
      await this.trace(
        "global_action_completed",
        { type: action.type, method, verified: action.verifier.type },
        action.riskLevel,
      );
      return result;
    } catch (error) {
      const errorMessage = safeGlobalActionError(error);
      const result: ActionExecutionResult = {
        success: false,
        latencyMs: Math.round(performance.now() - startedAt),
        evidence: [],
        error: errorMessage,
      };
      await this.trace(
        "global_action_failed",
        { type: action.type, method, error: errorMessage },
        action.riskLevel,
      );
      return result;
    }
  }

  private async verify(verifier: GlobalComputerVerification): Promise<string> {
    if (verifier.type === "active_window") {
      const state = await inspectActiveGlobalDesktop(
        this.runner,
        this.platform,
      );
      if (
        verifier.application &&
        !containsNormalized(state.application, verifier.application)
      ) {
        throw new Error("Active application did not match the verifier.");
      }
      if (
        verifier.title &&
        !containsNormalized(state.title ?? "", verifier.title)
      ) {
        throw new Error("Active window title did not match the verifier.");
      }
      return "Verified active application against the requested verifier.";
    }

    const running = await isGlobalProcessRunning(
      this.runner,
      this.platform,
      verifier.application,
    );
    if (!running) {
      throw new Error("Verified process is not running.");
    }
    return "Verified a running application against the requested verifier.";
  }

  private async trace(
    type: string,
    payload: Record<string, unknown>,
    riskLevel: RiskLevel,
  ): Promise<void> {
    await appendTraceEvent(this.traceFilePath, {
      eventId: randomUUID(),
      taskId: this.taskId,
      timestamp: new Date().toISOString(),
      type,
      payload,
      riskLevel,
    });
  }
}

export class ExecFileGlobalCommandRunner implements GlobalCommandRunner {
  public async run(command: GlobalCommand): Promise<GlobalCommandResult> {
    const result = await execFileAsync(command.file, command.args, {
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 1_024 * 1_024,
    });
    return {
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  }
}

export function getGlobalDesktopPlatform(
  platform: NodeJS.Platform = process.platform,
): GlobalDesktopPlatform {
  if (platform === "darwin" || platform === "win32" || platform === "linux") {
    return platform;
  }
  throw new Error(
    `Global computer control is supported on macOS, Windows, and Linux; received ${platform}.`,
  );
}

export function buildGlobalComputerCommand(
  action: GlobalComputerAction,
  platform: GlobalDesktopPlatform,
): GlobalCommand {
  switch (platform) {
    case "darwin":
      return buildMacCommand(action);
    case "win32":
      return buildWindowsCommand(action);
    case "linux":
      return buildLinuxCommand(action);
  }
}

export async function inspectGlobalControlCapability(
  options: Pick<GlobalComputerExecutorOptions, "platform" | "runner"> = {},
): Promise<GlobalControlCapability> {
  const platform = options.platform ?? getGlobalDesktopPlatform();
  const runner = options.runner ?? new ExecFileGlobalCommandRunner();
  try {
    if (platform === "darwin") {
      await runner.run({
        file: "osascript",
        args: [
          "-e",
          'tell application "System Events" to get name of first process',
        ],
      });
      return {
        platform,
        supported: true,
        detail:
          "Native AppleScript control is available. Grant this terminal Accessibility permission before controlling other apps.",
      };
    }
    if (platform === "win32") {
      await runner.run(
        powerShellCommand(
          "Add-Type -AssemblyName System.Windows.Forms; Write-Output ready",
        ),
      );
      return {
        platform,
        supported: true,
        detail:
          "Native Windows Forms and user32 control is available in this PowerShell environment.",
      };
    }
    if (process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland") {
      return {
        platform,
        supported: false,
        detail:
          "Wayland blocks the supported global-input backend. Run an X11 session with xdotool installed.",
      };
    }
    await runner.run({ file: "xdotool", args: ["--version"] });
    await runner.run({ file: "gtk-launch", args: ["--version"] });
    return {
      platform,
      supported: true,
      detail: "xdotool is available for the current X11 desktop session.",
    };
  } catch {
    return {
      platform,
      supported: false,
      detail: capabilityInstallHint(platform),
    };
  }
}

export async function inspectActiveGlobalDesktop(
  runner: GlobalCommandRunner,
  platform: GlobalDesktopPlatform,
): Promise<GlobalDesktopState> {
  switch (platform) {
    case "darwin": {
      const result = await runner.run({
        file: "osascript",
        args: ["-e", macActiveWindowScript],
      });
      const [application = "", title = ""] = result.stdout
        .trim()
        .split("\t", 2);
      if (!application) {
        throw new Error("macOS did not expose an active application.");
      }
      return { application, ...(title ? { title } : {}) };
    }
    case "win32": {
      const result = await runner.run(
        powerShellCommand(windowsActiveWindowScript),
      );
      return parseWindowsDesktopState(result.stdout);
    }
    case "linux": {
      const window = (
        await runner.run({
          file: "xdotool",
          args: ["getactivewindow"],
        })
      ).stdout.trim();
      if (!window) {
        throw new Error("Linux did not expose an active window.");
      }
      const [title, pid] = await Promise.all([
        runner.run({ file: "xdotool", args: ["getwindowname", window] }),
        runner.run({ file: "xdotool", args: ["getwindowpid", window] }),
      ]);
      const process = await runner.run({
        file: "ps",
        args: ["-p", pid.stdout.trim(), "-o", "comm="],
      });
      const application = process.stdout.trim();
      if (!application) {
        throw new Error("Linux did not expose the active window process.");
      }
      const normalizedTitle = title.stdout.trim();
      return {
        application,
        ...(normalizedTitle ? { title: normalizedTitle } : {}),
      };
    }
  }
}

async function isGlobalProcessRunning(
  runner: GlobalCommandRunner,
  platform: GlobalDesktopPlatform,
  application: string,
): Promise<boolean> {
  switch (platform) {
    case "darwin": {
      const result = await runner.run({
        file: "pgrep",
        args: ["-if", application],
      });
      return result.stdout.trim().length > 0;
    }
    case "win32": {
      const result = await runner.run(
        powerShellCommand(windowsProcessScript(application)),
      );
      return result.stdout.trim().toLowerCase() === "true";
    }
    case "linux": {
      const result = await runner.run({
        file: "pgrep",
        args: ["-if", application],
      });
      return result.stdout.trim().length > 0;
    }
  }
}

function buildMacCommand(action: GlobalComputerAction): GlobalCommand {
  switch (action.type) {
    case "os_click":
      if (
        action.methodPreference.includes("accessibility") &&
        action.target &&
        action.application
      ) {
        return appleScriptCommand(macAccessibilityClickScript, [
          action.application,
          action.target,
        ]);
      }
      return appleScriptCommand(macClickScript, [
        String(action.x ?? 0),
        String(action.y ?? 0),
      ]);
    case "os_type":
      return appleScriptCommand(macTypeScript, [action.text ?? ""]);
    case "os_press": {
      const key = parseHotkey(action.key ?? "");
      const modifierClause = macModifierClause(key.modifiers);
      const namedKeyCode = macNamedKeyCodes[key.key.toLowerCase()];
      return appleScriptCommand(
        namedKeyCode === undefined
          ? `tell application "System Events" to keystroke (item 1 of argv)${modifierClause}`
          : `tell application "System Events" to key code ${namedKeyCode}${modifierClause}`,
        namedKeyCode === undefined ? [key.key] : [],
      );
    }
    case "os_launch":
    case "os_focus":
      return { file: "open", args: ["-a", action.application ?? ""] };
  }
}

function buildWindowsCommand(action: GlobalComputerAction): GlobalCommand {
  switch (action.type) {
    case "os_click":
      if (
        action.methodPreference.includes("accessibility") &&
        action.target &&
        action.application
      ) {
        return powerShellCommand(
          windowsAccessibilityClickScript(action.application, action.target),
        );
      }
      return powerShellCommand(
        windowsClickScript(action.x ?? 0, action.y ?? 0),
      );
    case "os_type":
      return powerShellCommand(windowsTypeScript(action.text ?? ""));
    case "os_press":
      return powerShellCommand(windowsPressScript(action.key ?? ""));
    case "os_launch":
      return powerShellCommand(windowsLaunchScript(action.application ?? ""));
    case "os_focus":
      return powerShellCommand(windowsFocusScript(action.application ?? ""));
  }
}

function buildLinuxCommand(action: GlobalComputerAction): GlobalCommand {
  switch (action.type) {
    case "os_click":
      return {
        file: "xdotool",
        args: [
          "mousemove",
          "--sync",
          String(action.x),
          String(action.y),
          "click",
          "1",
        ],
      };
    case "os_type":
      return {
        file: "xdotool",
        args: [
          "type",
          "--clearmodifiers",
          "--delay",
          "10",
          "--",
          action.text ?? "",
        ],
      };
    case "os_press":
      return {
        file: "xdotool",
        args: ["key", "--clearmodifiers", linuxHotkey(action.key ?? "")],
      };
    case "os_launch":
      return { file: "gtk-launch", args: [action.application ?? ""] };
    case "os_focus":
      return {
        file: "xdotool",
        args: [
          "search",
          "--onlyvisible",
          "--name",
          action.application ?? "",
          "windowactivate",
          "--sync",
        ],
      };
  }
}

function appleScriptCommand(script: string, args: string[]): GlobalCommand {
  return { file: "osascript", args: ["-e", script, "--", ...args] };
}

function powerShellCommand(script: string): GlobalCommand {
  return {
    file: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShell(script),
    ],
  };
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function windowsClickScript(x: number, y: number): string {
  return `${windowsNativeInputScript}
[Native]::SetCursorPos(${x}, ${y}) | Out-Null
[Native]::mouse_event(0x0002, 0, 0, 0, 0)
[Native]::mouse_event(0x0004, 0, 0, 0, 0)`;
}

function windowsTypeScript(text: string): string {
  return `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${powerShellString(escapeWindowsType(text))})`;
}

function windowsPressScript(key: string): string {
  return `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait(${powerShellString(windowsHotkey(key))})`;
}

function windowsLaunchScript(application: string): string {
  return `Start-Process -FilePath ${powerShellString(application)}`;
}

function windowsFocusScript(application: string): string {
  return `${windowsNativeInputScript}
$process = Get-Process | Where-Object { $_.MainWindowTitle -like ${powerShellString(`*${application}*`)} -or $_.ProcessName -like ${powerShellString(`*${application}*`)} } | Select-Object -First 1
if ($null -eq $process -or $process.MainWindowHandle -eq 0) { throw "Application window was not found" }
if (-not [Native]::SetForegroundWindow($process.MainWindowHandle)) { throw "Unable to focus application window" }`;
}

function windowsProcessScript(application: string): string {
  return `$match = Get-Process | Where-Object { $_.ProcessName -like ${powerShellString(`*${application}*`)} -or $_.Path -like ${powerShellString(`*${application}*`)} } | Select-Object -First 1
Write-Output ($null -ne $match)`;
}

function powerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function escapeWindowsType(value: string): string {
  return value
    .replace(/[+^%~(){}[\]]/g, "{$&}")
    .replace(/\r\n?|\n/g, "{ENTER}");
}

interface ParsedHotkey {
  key: string;
  modifiers: string[];
}

function parseHotkey(value: string): ParsedHotkey {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const key = parts.pop();
  if (!key) {
    throw new Error("OS key presses require a key or hotkey.");
  }
  const modifiers = parts.map((part) => {
    const normalized = part.toLowerCase();
    if (normalized === "cmd" || normalized === "command") return "command";
    if (normalized === "ctrl" || normalized === "control") return "control";
    if (normalized === "alt" || normalized === "option") return "option";
    if (normalized === "shift") return "shift";
    throw new Error(`Unsupported hotkey modifier: ${part}.`);
  });
  if (new Set(modifiers).size !== modifiers.length) {
    throw new Error("OS key presses cannot repeat a hotkey modifier.");
  }
  const normalizedKey = key.toLowerCase();
  if (
    !/^[a-z0-9]$/i.test(key) &&
    macNamedKeyCodes[normalizedKey] === undefined
  ) {
    throw new Error(`Unsupported OS key: ${key}.`);
  }
  return { key, modifiers };
}

function macModifierClause(modifiers: string[]): string {
  if (modifiers.length === 0) {
    return "";
  }
  return ` using {${modifiers.map((modifier) => `${modifier} down`).join(", ")}}`;
}

function windowsHotkey(value: string): string {
  const { key, modifiers } = parseHotkey(value);
  const modifierPrefix = modifiers
    .map((modifier) => {
      if (modifier === "command") {
        throw new Error(
          "Command is only supported on macOS; use Ctrl on Windows.",
        );
      }
      return { control: "^", option: "%", shift: "+" }[modifier] ?? "";
    })
    .join("");
  return `${modifierPrefix}${windowsNamedKeys[key.toLowerCase()] ?? key}`;
}

function linuxHotkey(value: string): string {
  const { key, modifiers } = parseHotkey(value);
  const modifierPrefix = modifiers
    .map((modifier) => {
      if (modifier === "command") {
        throw new Error(
          "Command is only supported on macOS; use Ctrl on Linux.",
        );
      }
      return { control: "ctrl", option: "alt", shift: "shift" }[modifier] ?? "";
    })
    .join("+");
  const normalizedKey = linuxNamedKeys[key.toLowerCase()] ?? key;
  return modifierPrefix ? `${modifierPrefix}+${normalizedKey}` : normalizedKey;
}

function methodForGlobalAction(
  type: GlobalComputerAction["type"],
): ActionMethod {
  switch (type) {
    case "os_click":
      return "mouse";
    case "os_type":
    case "os_press":
      return "keyboard";
    case "os_launch":
    case "os_focus":
      return "accessibility";
  }
}

function parseWindowsDesktopState(stdout: string): GlobalDesktopState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error("Windows did not return an active-window observation.");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Windows did not return an active-window observation.");
  }
  const state = parsed as { application?: unknown; title?: unknown };
  if (typeof state.application !== "string" || !state.application.trim()) {
    throw new Error("Windows did not expose an active application.");
  }
  return {
    application: state.application,
    ...(typeof state.title === "string" && state.title
      ? { title: state.title }
      : {}),
  };
}

function containsNormalized(actual: string, expected: string): boolean {
  return actual.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
}

function capabilityInstallHint(platform: GlobalDesktopPlatform): string {
  if (platform === "linux") {
    return "Linux global control requires an X11 session and xdotool (for example, install xdotool with your distribution package manager).";
  }
  if (platform === "darwin") {
    return "macOS global control requires osascript and Accessibility permission for the calling terminal.";
  }
  return "Windows global control requires powershell.exe with Windows Forms and user32 access.";
}

function safeGlobalActionError(error: unknown): string {
  if (
    error instanceof Error &&
    /approval|method|verifier|active application|window title|process is not running|unsupported/i.test(
      error.message,
    )
  ) {
    return error.message;
  }
  return "Global computer action could not be completed. Run `lhic global doctor` and confirm the required OS accessibility permission.";
}

const macAccessibilityClickScript = `on run argv
  tell application "System Events"
    tell process (item 1 of argv)
      set targetElement to missing value
      repeat with win in windows
        try
          if exists (first UI element of win whose name is (item 2 of argv) or title is (item 2 of argv) or description is (item 2 of argv)) then
            set targetElement to (first UI element of win whose name is (item 2 of argv) or title is (item 2 of argv) or description is (item 2 of argv))
            exit repeat
          end if
          set allElements to entire contents of win
          repeat with el in allElements
            try
              if (name of el is (item 2 of argv)) or (title of el is (item 2 of argv)) or (description of el is (item 2 of argv)) then
                set targetElement to el
                exit repeat
              end if
            end try
          end repeat
          if targetElement is not missing value then exit repeat
        end try
      end repeat
      if targetElement is not missing value then
        click targetElement
      else
        error "Accessibility element " & (item 2 of argv) & " not found"
      end if
    end tell
  end tell
end run`;

const macClickScript = `on run argv
  tell application "System Events"
    click at {(item 1 of argv) as integer, (item 2 of argv) as integer}
  end tell
end run`;

const macTypeScript = `on run argv
  tell application "System Events" to keystroke (item 1 of argv)
end run`;

const macActiveWindowScript = `tell application "System Events"
  set frontProcess to first application process whose frontmost is true
  set appName to name of frontProcess
  try
    set windowName to name of front window of frontProcess
  on error
    set windowName to ""
  end try
  return appName & tab & windowName
end tell`;

const macNamedKeyCodes: Record<string, number> = {
  enter: 36,
  return: 36,
  escape: 53,
  esc: 53,
  tab: 48,
  space: 49,
  left: 123,
  arrowleft: 123,
  right: 124,
  arrowright: 124,
  down: 125,
  arrowdown: 125,
  up: 126,
  arrowup: 126,
  backspace: 51,
  delete: 51,
};

const windowsNamedKeys: Record<string, string> = {
  enter: "{ENTER}",
  return: "{ENTER}",
  escape: "{ESC}",
  esc: "{ESC}",
  tab: "{TAB}",
  space: " ",
  left: "{LEFT}",
  arrowleft: "{LEFT}",
  right: "{RIGHT}",
  arrowright: "{RIGHT}",
  down: "{DOWN}",
  arrowdown: "{DOWN}",
  up: "{UP}",
  arrowup: "{UP}",
  backspace: "{BACKSPACE}",
  delete: "{BACKSPACE}",
};

const linuxNamedKeys: Record<string, string> = {
  enter: "Return",
  return: "Return",
  escape: "Escape",
  esc: "Escape",
  tab: "Tab",
  space: "space",
  left: "Left",
  arrowleft: "Left",
  right: "Right",
  arrowright: "Right",
  down: "Down",
  arrowdown: "Down",
  up: "Up",
  arrowup: "Up",
  backspace: "BackSpace",
  delete: "BackSpace",
};

const windowsNativeInputScript = `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Native {
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@`;

const windowsActiveWindowScript = `${windowsNativeInputScript}
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WindowProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@
$window = [WindowProbe]::GetForegroundWindow()
if ($window -eq [IntPtr]::Zero) { throw "No active window" }
$title = New-Object System.Text.StringBuilder 1024
[WindowProbe]::GetWindowText($window, $title, $title.Capacity) | Out-Null
$processId = 0
[WindowProbe]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction Stop
@{ application = $process.ProcessName; title = $title.ToString() } | ConvertTo-Json -Compress`;

function windowsAccessibilityClickScript(application: string, target: string): string {
  return `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${application}*' -or $_.ProcessName -like '*${application}*' } | Select-Object -First 1
if ($null -eq $proc) { throw "Application process not found" }
$ae = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$condition = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "${target}")),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, "${target}"))
)
$elem = $ae.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $condition)
if ($null -eq $elem) { throw "Accessibility element ${target} not found" }
$invokePattern = $null
try {
  $invokePattern = $elem.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
} catch {}
if ($null -ne $invokePattern) {
  $invokePattern.Invoke()
} else {
  $point = $elem.GetClickablePoint()
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($point.X, $point.Y)
  ${windowsNativeInputScript}
  [Native]::mouse_event(0x0002, 0, 0, 0, 0)
  [Native]::mouse_event(0x0004, 0, 0, 0, 0)
}`;
}
