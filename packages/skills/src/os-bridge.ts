import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { isGlobalComputerAction } from "@lhic/schema";
import type {
  ActionExecutionResult,
  ActionMethod,
  GlobalComputerAction,
  GlobalComputerVerification,
  RiskLevel,
} from "@lhic/schema";
import {
  FileApprovalReplayStore,
  validateActionApproval,
  type ActionApproval,
  type ActionApprovalValidationOptions,
  type ApprovalReplayStore,
} from "@lhic/security";
import { appendTraceEvent } from "@lhic/trace";

export type GlobalDesktopPlatform = "darwin" | "win32" | "linux";

export interface GlobalCommand {
  file: string;
  args: string[];
  /** Optional standard input, passed without invoking a shell. */
  input?: string;
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

export interface GlobalDesktopGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GlobalComputerExecutorOptions {
  taskId?: string;
  traceFilePath?: string;
  platform?: GlobalDesktopPlatform;
  runner?: GlobalCommandRunner;
  approvalValidation?: ActionApprovalValidationOptions;
  approvalReplayStore?: ApprovalReplayStore;
  verificationTimeoutMs?: number;
  verificationPollIntervalMs?: number;
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
  private readonly approvalReplayStore: ApprovalReplayStore | undefined;
  private readonly verificationTimeoutMs: number;
  private readonly verificationPollIntervalMs: number;

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
    this.approvalReplayStore =
      options.approvalReplayStore ??
      (this.approvalValidation.requireSignature
        ? new FileApprovalReplayStore(
            join(dirname(this.traceFilePath), "approval-replay"),
          )
        : undefined);
    this.verificationTimeoutMs = boundedDuration(
      options.verificationTimeoutMs,
      5_000,
      "verificationTimeoutMs",
    );
    this.verificationPollIntervalMs = boundedDuration(
      options.verificationPollIntervalMs,
      100,
      "verificationPollIntervalMs",
    );
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
    const method = methodForGlobalAction(action);
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
      if (approval && approvalDecision.approvalId && this.approvalReplayStore) {
        const replayDecision = await this.approvalReplayStore.reserve(approval);
        if (!replayDecision.allowed) {
          throw new Error(replayDecision.reason);
        }
      }

      await this.verifyTargetBeforeDispatch(action);
      const commandResult = await this.runner.run(
        buildGlobalComputerCommand(action, this.platform),
      );
      const verificationEvidence = await this.verifyUntil(action.verifier);
      const output = outputForGlobalAction(
        action,
        commandResult,
        this.platform,
      );
      const result: ActionExecutionResult = {
        success: true,
        method,
        latencyMs: Math.round(performance.now() - startedAt),
        evidence: [
          `Dispatched ${action.type} through the ${this.platform} native ${method} API.`,
          verificationEvidence,
          ...(output === undefined
            ? []
            : [
                `Captured ${output.length} characters of ephemeral action output.`,
              ]),
        ],
        ...(output === undefined ? {} : { output }),
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

  private async verifyUntil(
    verifier: GlobalComputerVerification,
  ): Promise<string> {
    const deadline = performance.now() + this.verificationTimeoutMs;
    let lastError: unknown;
    do {
      const remainingMs = Math.max(1, Math.ceil(deadline - performance.now()));
      try {
        return await this.verifyWithin(verifier, remainingMs);
      } catch (error) {
        lastError = error;
      }
      const sleepMs = Math.min(
        this.verificationPollIntervalMs,
        Math.max(0, deadline - performance.now()),
      );
      if (sleepMs > 0) await sleep(sleepMs);
    } while (performance.now() < deadline);
    throw lastError ?? new Error("Global desktop verification timed out.");
  }

  private async verifyWithin(
    verifier: GlobalComputerVerification,
    timeoutMs: number,
  ): Promise<string> {
    const { promise: interrupted, reject } = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => reject(new Error("Global desktop verification timed out.")),
      timeoutMs,
    );
    try {
      return await Promise.race([this.verify(verifier), interrupted]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async verifyTargetBeforeDispatch(
    action: GlobalComputerAction,
  ): Promise<void> {
    if (!requiresActiveWindowTargeting(action)) {
      return;
    }
    if (action.verifier.type !== "active_window") {
      throw new Error(
        "Keyboard and coordinate input require an active-window verifier before dispatch.",
      );
    }
    if (!action.verifier.application && !action.verifier.title) {
      throw new Error(
        "Keyboard and coordinate input require an active-window verifier with an application or title.",
      );
    }
    await this.verifyWithin(action.verifier, this.verificationTimeoutMs);
    if (
      action.type === "os_click" &&
      methodForGlobalAction(action) === "mouse"
    ) {
      const geometry = await inspectGlobalDesktopGeometry(
        this.runner,
        this.platform,
      );
      const x = action.x!;
      const y = action.y!;
      if (
        x < geometry.left ||
        y < geometry.top ||
        x >= geometry.left + geometry.width ||
        y >= geometry.top + geometry.height
      ) {
        throw new Error(
          `Coordinate (${x}, ${y}) is outside the current desktop bounds.`,
        );
      }
    }
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
    const { promise, resolve, reject } =
      Promise.withResolvers<GlobalCommandResult>();
    const child = execFile(
      command.file,
      command.args,
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1_024 * 1_024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (command.input !== undefined) {
      child.stdin?.end(command.input);
    }
    return promise;
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

export async function inspectGlobalDesktopGeometry(
  runner: GlobalCommandRunner,
  platform: GlobalDesktopPlatform,
): Promise<GlobalDesktopGeometry> {
  if (platform === "darwin") {
    const result = await runner.run({
      file: "osascript",
      args: [
        "-e",
        'tell application "Finder" to get bounds of window of desktop',
      ],
    });
    const values = result.stdout.match(/-?\d+/g)?.map(Number);
    if (!values || values.length < 4) {
      throw new Error("macOS did not expose the desktop bounds.");
    }
    const [left, top, right, bottom] = values;
    return validDesktopGeometry({
      left: left!,
      top: top!,
      width: right! - left!,
      height: bottom! - top!,
    });
  }
  if (platform === "win32") {
    const result = await runner.run(
      powerShellCommand(windowsDesktopGeometryScript),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error("Windows did not expose the desktop bounds.");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Windows did not expose the desktop bounds.");
    }
    const candidate = parsed as Record<string, unknown>;
    return validDesktopGeometry({
      left: candidate.left,
      top: candidate.top,
      width: candidate.width,
      height: candidate.height,
    });
  }
  const result = await runner.run({
    file: "xdotool",
    args: ["getdisplaygeometry"],
  });
  const values = result.stdout.trim().split(/\s+/).map(Number);
  return validDesktopGeometry({
    left: 0,
    top: 0,
    width: values[0],
    height: values[1],
  });
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
    case "os_screenshot":
      return {
        file: "screencapture",
        args: [
          "-x",
          "-t",
          "png",
          action.outputPath ?? "/tmp/lhic-screenshot.png",
        ],
      };
    case "os_observe":
      return appleScriptCommand(macObserveScript, [
        action.application ?? "",
        action.observeScope ?? "active_window",
      ]);
    case "os_scroll": {
      const direction = action.scrollDirection ?? "down";
      const amount = action.scrollAmount ?? 3;
      return {
        file: "osascript",
        args: [
          "-e",
          `tell application "System Events" to scroll ${direction} ${amount}`,
        ],
      };
    }
    case "os_clipboard":
      if (action.clipboardAction === "read") {
        return { file: "pbpaste", args: [] };
      }
      if (action.clipboardAction === "copy") {
        return { file: "pbcopy", args: [], input: action.text ?? "" };
      }
      // paste: Cmd+V
      return appleScriptCommand(
        'tell application "System Events" to keystroke "v" using command down',
        [],
      );
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
    case "os_screenshot":
      return powerShellCommand(
        windowsScreenshotScript(
          action.outputPath ?? "\\temp\\lhic-screenshot.png",
        ),
      );
    case "os_observe":
      return powerShellCommand(
        windowsObserveScript(
          action.application ?? "",
          action.observeScope ?? "active_window",
        ),
      );
    case "os_scroll": {
      const direction = action.scrollDirection ?? "down";
      const amount = action.scrollAmount ?? 3;
      return powerShellCommand(windowsScrollScript(direction, amount));
    }
    case "os_clipboard":
      if (action.clipboardAction === "read") {
        return powerShellCommand("Get-Clipboard");
      }
      if (action.clipboardAction === "copy") {
        return powerShellCommand(
          `Set-Clipboard -Value ${powerShellString(action.text ?? "")}`,
        );
      }
      // paste: Ctrl+V
      return powerShellCommand(
        `${windowsNativeInputScript}
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^v")`,
      );
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
          "--limit",
          "1",
          "--name",
          action.application ?? "",
          "windowactivate",
          "--sync",
        ],
      };
    case "os_screenshot":
      return {
        file: "import",
        args: [
          "-window",
          "root",
          action.outputPath ?? "/tmp/lhic-screenshot.png",
        ],
      };
    case "os_observe":
      if ((action.observeScope ?? "active_window") === "active_window") {
        return {
          file: "xdotool",
          args: ["getactivewindow", "getwindowname"],
        };
      }
      return {
        file: "xdotool",
        args: [
          "search",
          "--onlyvisible",
          ...(action.observeScope === "application" ? ["--limit", "1"] : []),
          "--name",
          action.observeScope === "application"
            ? (action.application ?? "")
            : ".",
          "getwindowname",
        ],
      };
    case "os_scroll": {
      const direction = action.scrollDirection ?? "down";
      const amount = action.scrollAmount ?? 3;
      const button = { up: "4", down: "5", left: "6", right: "7" }[direction];
      return {
        file: "xdotool",
        args: ["click", "--repeat", String(amount), button],
      };
    }
    case "os_clipboard":
      if (action.clipboardAction === "read") {
        return { file: "xclip", args: ["-selection", "clipboard", "-o"] };
      }
      if (action.clipboardAction === "copy") {
        return {
          file: "xclip",
          args: ["-selection", "clipboard", "-i"],
          input: action.text ?? "",
        };
      }
      // paste: Ctrl+V
      return {
        file: "xdotool",
        args: ["key", "--clearmodifiers", "ctrl+v"],
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

function methodForGlobalAction(action: GlobalComputerAction): ActionMethod {
  switch (action.type) {
    case "os_click":
      return action.methodPreference.includes("accessibility") &&
        action.target &&
        action.application
        ? "accessibility"
        : "mouse";
    case "os_type":
    case "os_press":
      return "keyboard";
    case "os_launch":
    case "os_focus":
      return "accessibility";
    case "os_screenshot":
    case "os_observe":
      return "vision";
    case "os_scroll":
      return "mouse";
    case "os_clipboard":
      return "api";
  }
}

function requiresActiveWindowTargeting(action: GlobalComputerAction): boolean {
  return (
    action.type === "os_type" ||
    action.type === "os_press" ||
    action.type === "os_scroll" ||
    (action.type === "os_click" &&
      !(
        action.methodPreference.includes("accessibility") &&
        action.target &&
        action.application
      ))
  );
}

// macOS accessibility tree observation script
const macObserveScript = `on run argv
  set appName to item 1 of argv
  set scope to item 2 of argv
  set resultList to {}

  tell application "System Events"
    if scope is "active_window" then
      set targetProcess to first application process whose frontmost is true
    else if scope is "application" and appName is not "" then
      set targetProcess to first application process whose name is appName
    else
      set targetProcess to first application process whose frontmost is true
    end if

    set procName to name of targetProcess
    set windowList to {}

    repeat with win in windows of targetProcess
      try
        set winTitle to name of win
        set elementList to {}
        set allElements to entire contents of win
        repeat with el in allElements
          try
            set elRole to role of el
            set elName to ""
            try
              set elName to name of el
            end try
            set elDesc to ""
            try
              set elDesc to description of el
            end try
            set elValue to ""
            try
              set elValue to value of el
            end try
            set elEnabled to true
            try
              set elEnabled to enabled of el
            end try
            set elFocused to false
            try
              set elFocused to focused of el
            end try

            set elementRecord to {role:elRole, name:elName, description:elDesc, value:elValue, enabled:elEnabled, focused:elFocused}
            set end of elementList to elementRecord
          end try
        end repeat

        set windowRecord to {title:winTitle, elements:elementList}
        set end of windowList to windowRecord
      end try
    end repeat

    return procName & "||" & (windowList as text)
  end tell
end run`;

// Windows screenshot script
function windowsScreenshotScript(outputPath: string): string {
  return `Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save(${powerShellString(outputPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output ${powerShellString(`Screenshot saved to ${outputPath}`)}`;
}

// Windows accessibility tree observation script
function windowsObserveScript(application: string, scope: string): string {
  return `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ActiveWindowProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

$scope = ${powerShellString(scope)}
$application = ${powerShellString(application)}
if ($scope -eq 'active_window') {
  $window = [ActiveWindowProbe]::GetForegroundWindow()
  $processId = 0
  [ActiveWindowProbe]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
  $processes = @(Get-Process -Id $processId -ErrorAction Stop)
} elseif ($scope -eq 'application') {
  $processes = @(Get-Process | Where-Object {
    $_.MainWindowHandle -ne 0 -and
    ($_.MainWindowTitle -like ('*' + $application + '*') -or $_.ProcessName -like ('*' + $application + '*'))
  } | Select-Object -First 1)
} else {
  $processes = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })
}
if ($processes.Count -eq 0) { throw "Application window was not found" }

$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Get-ElementTree($element, $depth = 0) {
  $result = @()
  if ($depth -gt 8) { return $result }
  try {
    $value = ""
    try {
      $vp = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value = $vp.Current.Value
    } catch {}
    $result += @{
      role = $element.Current.ControlType.ProgrammaticName
      name = $element.Current.Name
      enabled = $element.Current.IsEnabled
      focused = $element.Current.HasKeyboardFocus
      value = $value
      depth = $depth
    }
    $child = $walker.GetFirstChild($element)
    while ($null -ne $child) {
      $result += Get-ElementTree $child ($depth + 1)
      $child = $walker.GetNextSibling($child)
    }
  } catch {}
  return $result
}

$observations = foreach ($proc in $processes) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
  if ($null -ne $root) {
    @{
      application = $proc.ProcessName
      title = $proc.MainWindowTitle
      elements = @(Get-ElementTree $root)
    }
  }
}
@($observations) | ConvertTo-Json -Compress -Depth 12`;
}

// Windows scroll script
function windowsScrollScript(direction: string, amount: number): string {
  const horizontal = direction === "left" || direction === "right";
  const positive = direction === "up" || direction === "right";
  const scrollDelta = (positive ? amount : -amount) * 120;
  const eventFlag = horizontal ? "0x1000" : "0x0800";
  return `${windowsNativeInputScript}
[Native]::mouse_event(${eventFlag}, 0, 0, ${scrollDelta}, [UIntPtr]::Zero)`;
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

function validDesktopGeometry(
  geometry: Record<keyof GlobalDesktopGeometry, unknown>,
): GlobalDesktopGeometry {
  const { left, top, width, height } = geometry;
  if (
    typeof left !== "number" ||
    !Number.isInteger(left) ||
    typeof top !== "number" ||
    !Number.isInteger(top) ||
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    width <= 0 ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height <= 0
  ) {
    throw new Error("The operating system returned invalid desktop bounds.");
  }
  return { left, top, width, height };
}

function outputForGlobalAction(
  action: GlobalComputerAction,
  result: GlobalCommandResult,
  platform: GlobalDesktopPlatform,
): string | undefined {
  if (action.type === "os_observe") {
    const output = result.stdout.trim();
    if (!output) {
      throw new Error("Desktop observation returned no output.");
    }
    return output.slice(0, 256_000);
  }
  if (action.type === "os_clipboard" && action.clipboardAction === "read") {
    return result.stdout.slice(0, 256_000);
  }
  if (action.type === "os_screenshot") {
    return (
      action.outputPath ??
      (platform === "win32"
        ? "\\temp\\lhic-screenshot.png"
        : "/tmp/lhic-screenshot.png")
    );
  }
  return undefined;
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const duration = value ?? fallback;
  if (!Number.isInteger(duration) || duration < 1 || duration > 30_000) {
    throw new Error(`${name} must be an integer from 1 to 30000 milliseconds.`);
  }
  return duration;
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
    /approval|method|verifier|verification|timed out|active application|window title|process is not running|unsupported|coordinate|desktop bounds|observation/i.test(
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
      set requestedTarget to item 2 of argv
      set requestedRole to ""
      if requestedTarget starts with "role:" then
        set requestedRole to text 6 thru -1 of requestedTarget
      end if
      repeat with win in windows
        try
          if requestedRole is "" then
            if exists (first UI element of win whose name is requestedTarget or title is requestedTarget or description is requestedTarget) then
              set targetElement to (first UI element of win whose name is requestedTarget or title is requestedTarget or description is requestedTarget)
              exit repeat
            end if
          end if
          set allElements to entire contents of win
          repeat with el in allElements
            try
              if requestedRole is not "" and role of el is requestedRole then
                set targetElement to el
                exit repeat
              else if requestedRole is "" and ((name of el is requestedTarget) or (title of el is requestedTarget) or (description of el is requestedTarget)) then
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
        error "Accessibility element " & requestedTarget & " not found"
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
  [DllImport("user32.dll", SetLastError = true)] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
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

const windowsDesktopGeometryScript = `Add-Type -AssemblyName System.Windows.Forms
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
@{
  left = $bounds.Left
  top = $bounds.Top
  width = $bounds.Width
  height = $bounds.Height
} | ConvertTo-Json -Compress`;

function windowsAccessibilityClickScript(
  application: string,
  target: string,
): string {
  return `Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$application = ${powerShellString(application)}
$target = ${powerShellString(target)}
$proc = Get-Process | Where-Object {
  $_.MainWindowHandle -ne 0 -and
  ($_.MainWindowTitle -like ('*' + $application + '*') -or $_.ProcessName -like ('*' + $application + '*'))
} | Select-Object -First 1
if ($null -eq $proc) { throw "Application process not found" }
$ae = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
$condition = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $target)),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $target))
)
$elem = $ae.FindFirst([System.Windows.Automation.TreeScope]::Subtree, $condition)
if ($null -eq $elem) { throw "Accessibility element was not found" }
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
