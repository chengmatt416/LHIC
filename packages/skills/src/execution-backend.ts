import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { GlobalComputerAction } from "@lhic/schema";

import type { GlobalCommand, GlobalCommandResult } from "./os-bridge.js";

export type ExecutionBackendId =
  | "peekaboo"
  | "flaui"
  | "omniparser"
  | "native";

export interface ExecutionElement {
  id: string;
  label?: string;
  role?: string;
  /** Screen-space frame in CSS pixels. */
  frame?: { x: number; y: number; width: number; height: number };
  interactable?: boolean;
}

export interface ElementObservation {
  elements: ExecutionElement[];
  capturedAt: string;
}

export interface ExecutionBackendProbe {
  id: ExecutionBackendId;
  available: boolean;
  detail: string;
}

export interface BackendDispatchResult {
  result: GlobalCommandResult;
  backend: ExecutionBackendId;
  evidence: string[];
}

/**
 * Element-grounded OS execution backend. A backend observes the desktop
 * (accessibility/DOM equivalent), resolves an action target to an element,
 * and performs the action against the element instead of raw coordinates.
 */
export interface ExecutionBackend {
  readonly id: ExecutionBackendId;
  probe(): Promise<ExecutionBackendProbe>;
  observe(options: {
    application?: string;
    scope?: string;
  }): Promise<ElementObservation>;
  findElement(
    target: string,
    observation: ElementObservation,
  ): ExecutionElement | undefined;
  /**
   * Executes the action against an element (or coordinates). Returns
   * undefined when the action shape is unsupported by this backend.
   */
  execute(
    action: GlobalComputerAction,
    element?: ExecutionElement,
  ): Promise<BackendDispatchResult | undefined>;
}

export interface ExecutionBackendOptions {
  /** Platform override for probes/tests. */
  platform?: NodeJS.Platform;
  /** Peekaboo CLI binary (macOS). */
  peekabooBin?: string;
  /** Path to the compiled FlaUI bridge DLL (Windows). */
  flauiDll?: string;
  /** Python interpreter for the OmniParser helper (fallback). */
  omniparserPython?: string;
  /** Directory containing parse_screenshot.py. */
  omniparserDir?: string;
  /** Spawn override for tests. */
  execFileImplementation?: typeof execFile;
  /** Timeout for backend subprocesses (ms). */
  timeoutMs?: number;
}

const backendTimeoutMs = 15_000;

export function executionBackendOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ExecutionBackendOptions & { backendMode?: string } {
  const mode = environment.LHIC_EXECUTION_BACKEND?.toLocaleLowerCase() ?? "auto";
  if (
    mode !== "auto" &&
    mode !== "peekaboo" &&
    mode !== "flaui" &&
    mode !== "omniparser" &&
    mode !== "native"
  ) {
    throw new Error(
      `LHIC_EXECUTION_BACKEND must be auto, peekaboo, flaui, omniparser, or native (got ${mode}).`,
    );
  }
  return {
    ...(environment.LHIC_PEEKABOO_BIN
      ? { peekabooBin: environment.LHIC_PEEKABOO_BIN }
      : {}),
    ...(environment.LHIC_FLAUI_DLL
      ? { flauiDll: environment.LHIC_FLAUI_DLL }
      : {}),
    ...(environment.LHIC_OMNIPARSER_PYTHON
      ? { omniparserPython: environment.LHIC_OMNIPARSER_PYTHON }
      : {}),
    ...(environment.LHIC_OMNIPARSER_DIR
      ? { omniparserDir: environment.LHIC_OMNIPARSER_DIR }
      : {}),
    backendMode: mode,
  };
}

export class PeekabooBackend implements ExecutionBackend {  public readonly id = "peekaboo" as const;
  private readonly binary: string;
  private readonly execFileImplementation: typeof execFile;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;

  public constructor(options: ExecutionBackendOptions = {}) {
    this.binary = options.peekabooBin ?? "peekaboo";
    this.execFileImplementation = options.execFileImplementation ?? execFile;
    this.timeoutMs = options.timeoutMs ?? backendTimeoutMs;
    this.platform = options.platform ?? process.platform;
  }

  public async probe(): Promise<ExecutionBackendProbe> {
    if (this.platform !== "darwin") {
      return {
        id: this.id,
        available: false,
        detail:
          "Peekaboo is a macOS execution layer; on this OS LHIC uses its traditional layer.",
      };
    }
    const version = await macOsVersion(this.execFileImplementation);
    if (version && version.major < 15) {
      return {
        id: this.id,
        available: false,
        detail: `Peekaboo requires macOS 15 or later (this system is ${version.label}); falling back to the traditional osascript layer.`,
      };
    }
    try {
      const result = await this.run(["--version"]);
      return {
        id: this.id,
        available: true,
        detail:
          result.stdout.trim() ||
          `Peekaboo CLI available on macOS ${version?.label ?? "unknown"}`,
      };
    } catch {
      return {
        id: this.id,
        available: false,
        detail:
          "Peekaboo is not installed. Install with `brew install steipete/tap/peekaboo`; until then LHIC uses the traditional osascript layer.",
      };
    }
  }

  public async observe(options: {
    application?: string;
    scope?: string;
  }): Promise<ElementObservation> {
    const args = ["see", "--json"];
    if (options.application) {
      args.push("--app", options.application);
    } else if (options.scope === "screen") {
      args.push("--mode", "screen");
    }
    const stdout = (await this.run(args)).stdout;
    return parseElementObservation(stdout);
  }

  public findElement(
    target: string,
    observation: ElementObservation,
  ): ExecutionElement | undefined {
    const needle = target.toLocaleLowerCase();
    const exact = observation.elements.find(
      (element) =>
        element.label?.toLocaleLowerCase() === needle ||
        element.id === target,
    );
    if (exact) return exact;
    return observation.elements.find((element) =>
      element.label?.toLocaleLowerCase().includes(needle),
    );
  }

  public async execute(
    action: GlobalComputerAction,
    element?: ExecutionElement,
  ): Promise<BackendDispatchResult | undefined> {
    const application = action.application;
    const onElement = element ? ["--on", element.id] : [];
    const appArgs = application ? ["--app", application] : [];
    let args: string[];
    switch (action.type) {
      case "os_click":
        if (element) {
          args = ["click", ...onElement, ...appArgs];
        } else if (action.target) {
          args = ["click", action.target, ...appArgs];
        } else if (
          typeof action.x === "number" &&
          typeof action.y === "number"
        ) {
          args = ["click", "--at", `${action.x},${action.y}`, ...appArgs];
        } else {
          return undefined;
        }
        break;
      case "os_type":
        if (!action.text) return undefined;
        args = element
          ? ["set-value", action.text, ...onElement, ...appArgs]
          : ["type", action.text, ...appArgs];
        break;
      case "os_press":
        if (!action.key) return undefined;
        args = ["press", normalizePressKey(action.key), ...appArgs];
        break;
      case "os_scroll":
        if (!action.scrollDirection) return undefined;
        args = element
          ? [
              "scroll",
              action.scrollDirection,
              ...onElement,
              ...appArgs,
            ]
          : ["scroll", action.scrollDirection, ...appArgs];
        break;
      case "os_launch":
        if (!action.application) return undefined;
        args = ["app", "launch", action.application];
        break;
      case "os_focus":
        if (!action.application) return undefined;
        args = ["window", "focus", "--app", action.application];
        break;
      case "os_screenshot":
        if (!action.outputPath) return undefined;
        args = [
          "see",
          "--no-elements",
          "--mode",
          "screen",
          "--path",
          action.outputPath,
        ];
        break;
      case "os_observe":
        args = ["see", "--json"];
        break;
      case "os_clipboard":
        // Peekaboo manages the pasteboard; map copy/paste/read to the
        // native clipboard path instead of guessing its subcommand surface.
        return undefined;
      default:
        return undefined;
    }
    const result = await this.run(args);
    return {
      result,
      backend: this.id,
      evidence: [
        `Dispatched ${action.type} through the Peekaboo element backend (${args.slice(0, 2).join(" ")}).`,
        ...(element
          ? [`Targeted element ${element.id}${element.label ? ` (${element.label})` : ""}.`]
          : []),
      ],
    };
  }

  private run(args: string[]): Promise<GlobalCommandResult> {
    return execFileToResult(
      this.execFileImplementation,
      this.binary,
      args,
      this.timeoutMs,
    );
  }
}

export class FlaUIBackend implements ExecutionBackend {
  public readonly id = "flaui" as const;
  private readonly dll: string;
  private readonly execFileImplementation: typeof execFile;
  private readonly timeoutMs: number;
  private readonly platform: NodeJS.Platform;

  public constructor(options: ExecutionBackendOptions = {}) {
    this.dll = options.flauiDll ?? "lhic-flaui/lhic-flaui.dll";
    this.execFileImplementation = options.execFileImplementation ?? execFile;
    this.timeoutMs = options.timeoutMs ?? backendTimeoutMs;
    this.platform = options.platform ?? process.platform;
  }

  public async probe(): Promise<ExecutionBackendProbe> {
    if (this.platform !== "win32") {
      return {
        id: this.id,
        available: false,
        detail:
          "FlaUI is a Windows execution layer; on this OS LHIC uses its traditional layer.",
      };
    }
    const version = await windowsVersion(this.execFileImplementation);
    if (
      version &&
      (version.major < 10 ||
        (version.major === 10 && version.build < 14_393))
    ) {
      return {
        id: this.id,
        available: false,
        detail: `FlaUI requires Windows 10 1607 or later (this system is ${version.label}); falling back to the traditional PowerShell layer.`,
      };
    }
    try {
      const result = await this.run(["probe"]);
      return {
        id: this.id,
        available: true,
        detail:
          result.stdout.trim() ||
          `FlaUI bridge available on Windows ${version?.label ?? "unknown"}`,
      };
    } catch {
      return {
        id: this.id,
        available: false,
        detail:
          "The FlaUI bridge is not available. Build it with scripts/build-flaui-helper.ps1 and point LHIC_FLAUI_DLL at the published DLL; until then LHIC uses the traditional PowerShell layer.",
      };
    }
  }

  public async observe(options: {
    application?: string;
    scope?: string;
  }): Promise<ElementObservation> {
    const args = ["observe"];
    if (options.application) {
      args.push("--app", options.application);
    }
    const stdout = (await this.run(args)).stdout;
    return parseElementObservation(stdout);
  }

  public findElement(
    target: string,
    observation: ElementObservation,
  ): ExecutionElement | undefined {
    const needle = target.toLocaleLowerCase();
    const exact = observation.elements.find(
      (element) =>
        element.label?.toLocaleLowerCase() === needle ||
        element.id === target,
    );
    if (exact) return exact;
    return observation.elements.find((element) =>
      element.label?.toLocaleLowerCase().includes(needle),
    );
  }

  public async execute(
    action: GlobalComputerAction,
    element?: ExecutionElement,
  ): Promise<BackendDispatchResult | undefined> {
    const onElement = element ? ["--on", element.id] : [];
    let args: string[];
    switch (action.type) {
      case "os_click": {
        if (element) {
          args = ["click", ...onElement];
        } else if (action.target) {
          args = ["click", "--label", action.target];
        } else if (
          typeof action.x === "number" &&
          typeof action.y === "number"
        ) {
          args = ["click", "--at", `${action.x},${action.y}`];
        } else {
          return undefined;
        }
        break;
      }
      case "os_type":
        if (!action.text) return undefined;
        args = ["type", ...(element ? onElement : []), "--text", action.text];
        break;
      case "os_press":
        if (!action.key) return undefined;
        args = ["press", normalizePressKey(action.key)];
        break;
      case "os_scroll":
        if (!action.scrollDirection) return undefined;
        args = ["scroll", action.scrollDirection, ...onElement];
        break;
      case "os_screenshot":
        if (!action.outputPath) return undefined;
        args = ["screenshot", action.outputPath];
        break;
      case "os_observe":
        args = ["observe"];
        break;
      default:
        return undefined;
    }
    const result = await this.run(args);
    return {
      result,
      backend: this.id,
      evidence: [
        `Dispatched ${action.type} through the FlaUI element backend (${args[0]}).`,
        ...(element
          ? [`Targeted element ${element.id}${element.label ? ` (${element.label})` : ""}.`]
          : []),
      ],
    };
  }

  private run(args: string[]): Promise<GlobalCommandResult> {
    return execFileToResult(
      this.execFileImplementation,
      "dotnet",
      [this.dll, ...args],
      this.timeoutMs,
    );
  }
}

export class OmniParserBackend implements ExecutionBackend {
  public readonly id = "omniparser" as const;
  private readonly python: string;
  private readonly parserDir: string;
  private readonly execFileImplementation: typeof execFile;
  private readonly timeoutMs: number;

  public constructor(options: ExecutionBackendOptions = {}) {
    this.python = options.omniparserPython ?? "python3";
    this.parserDir =
      options.omniparserDir ??
      fileURLToPath(new URL("./execution/omniparser/", import.meta.url));
    this.execFileImplementation = options.execFileImplementation ?? execFile;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  public async probe(): Promise<ExecutionBackendProbe> {
    try {
      const result = await this.run(["probe"]);
      return {
        id: this.id,
        available: true,
        detail: result.stdout.trim() || "OmniParser helper available",
      };
    } catch {
      return {
        id: this.id,
        available: false,
        detail:
          "The OmniParser V2 helper is not ready. Install the weights and requirements documented in packages/skills/src/execution/omniparser/README.md.",
      };
    }
  }

  public async observe(options: {
    application?: string;
    scope?: string;
  }): Promise<ElementObservation> {
    const screenshot = await captureScreenshot(options.application);
    if (!screenshot) {
      return { elements: [], capturedAt: new Date().toISOString() };
    }
    return this.parseScreenshot(screenshot);
  }

  public async parseScreenshot(screenshotPath: string): Promise<ElementObservation> {
    const stdout = (
      await this.run(["parse", "--screenshot", screenshotPath])
    ).stdout;
    return parseElementObservation(stdout);
  }

  public findElement(
    target: string,
    observation: ElementObservation,
  ): ExecutionElement | undefined {
    const needle = target.toLocaleLowerCase();
    const exact = observation.elements.find(
      (element) =>
        element.label?.toLocaleLowerCase() === needle || element.id === target,
    );
    if (exact) return exact;
    return observation.elements.find((element) =>
      element.label?.toLocaleLowerCase().includes(needle),
    );
  }

  public async execute(): Promise<BackendDispatchResult | undefined> {
    // OmniParser only grounds targets; actual input goes through the native
    // coordinate layer so the executor keeps approval + verification.
    return undefined;
  }

  private run(args: string[]): Promise<GlobalCommandResult> {
    return execFileToResult(
      this.execFileImplementation,
      this.python,
      [join(this.parserDir, "parse_screenshot.py"), ...args],
      this.timeoutMs,
    );
  }
}

/**
 * Chains element-grounded backends and falls back to OmniParser V2 screen
 * parsing when the accessibility tree has no match, then to native
 * coordinates. The returned GlobalCommandResult is dispatched by the
 * executor, which still owns approval and post-action verification.
 */
export class ElementGroundedDispatcher {
  private readonly backend: ExecutionBackend | undefined;
  private readonly omniparser: OmniParserBackend | undefined;
  private readonly runner: {
    run(command: GlobalCommand): Promise<GlobalCommandResult>;
  };
  private readonly platform: NodeJS.Platform;
  private readonly buildNative: (
    action: GlobalComputerAction,
  ) => GlobalCommand;
  private readonly captureScreenshot: (
    application?: string,
  ) => Promise<string | undefined>;

  public constructor(options: {
    backend?: ExecutionBackend;
    omniparser?: OmniParserBackend;
    runner: { run(command: GlobalCommand): Promise<GlobalCommandResult> };
    platform: NodeJS.Platform;
    buildNative: (action: GlobalComputerAction) => GlobalCommand;
    captureScreenshot?: (
      application?: string,
    ) => Promise<string | undefined>;
  }) {
    this.backend = options.backend;
    this.omniparser = options.omniparser;
    this.runner = options.runner;
    this.platform = options.platform;
    this.buildNative = options.buildNative;
    this.captureScreenshot = options.captureScreenshot ?? captureScreenshot;
  }

  public async dispatch(
    action: GlobalComputerAction,
  ): Promise<BackendDispatchResult | undefined> {
    if (this.backend) {
      try {
        const observation = await this.backend.observe({
          ...(action.application ? { application: action.application } : {}),
          ...(action.observeScope ? { scope: action.observeScope } : {}),
        });
        const element = action.target
          ? this.backend.findElement(action.target, observation)
          : undefined;
        const dispatched = await this.backend.execute(action, element);
        if (dispatched) return dispatched;
      } catch {
        // Fall through to the next layer; never fail the action here.
      }
    }
    if (this.omniparser && action.target) {
      try {
        const screenshot = await this.captureScreenshot(action.application);
        if (screenshot) {
          const observation = await this.omniparser.parseScreenshot(screenshot);
          const element = this.omniparser.findElement(
            action.target,
            observation,
          );
          if (element?.frame) {
            const x = Math.round(
              element.frame.x + element.frame.width / 2,
            );
            const y = Math.round(
              element.frame.y + element.frame.height / 2,
            );
            const command = this.buildNative({ ...action, x, y });
            const result = await this.runner.run(command);
            return {
              result,
              backend: "omniparser",
              evidence: [
                `OmniParser V2 located "${action.target}" at (${x}, ${y}) on ${this.platform}.`,
                ...(element.label
                  ? [`Parsed label: ${element.label}.`]
                  : []),
              ],
            };
          }
        }
      } catch {
        // Fall through to native coordinates.
      }
    }
    return undefined;
  }
}

export interface ResolvedExecutionChain {
  /** Platform element backend (Peekaboo on macOS, FlaUI on Windows). */
  backend?: ExecutionBackend;
  /** OmniParser V2 screenshot-grounding fallback. */
  omniparser?: OmniParserBackend;
  probe: ExecutionBackendProbe;
}

/**
 * Resolves the element-grounded execution chain from environment + OS
 * version. Rules:
 *   - auto (default): platform element backend when the OS version supports
 *     it AND the tool is installed; OmniParser V2 joins as the
 *     DOM-invisible fallback; otherwise the traditional layer is used.
 *   - peekaboo / flaui / omniparser: force one backend (probe still gates on
 *     OS version + install); when unavailable the traditional layer is used.
 *   - native: traditional layer only.
 */
export async function resolveExecutionChain(
  options: ExecutionBackendOptions & { backendMode?: string } = {},
): Promise<ResolvedExecutionChain> {
  const platform = options.platform ?? process.platform;
  const mode = options.backendMode ?? "auto";
  if (mode === "native") {
    return {
      probe: { id: "native", available: true, detail: "Traditional platform layer" },
    };
  }
  if (mode === "peekaboo" || mode === "flaui" || mode === "omniparser") {
    const backend =
      mode === "peekaboo"
        ? new PeekabooBackend(options)
        : mode === "flaui"
          ? new FlaUIBackend(options)
          : new OmniParserBackend(options);
    const probe = await backend.probe();
    return {
      ...(probe.available ? { backend } : {}),
      ...(mode === "omniparser" && probe.available
        ? { omniparser: backend as OmniParserBackend }
        : {}),
      probe,
    };
  }
  const primary =
    platform === "darwin"
      ? new PeekabooBackend(options)
      : platform === "win32"
        ? new FlaUIBackend(options)
        : undefined;
  const omniparser = new OmniParserBackend(options);
  const [primaryProbe, omniparserProbe] = await Promise.all([
    primary ? primary.probe() : Promise.resolve(undefined),
    omniparser.probe(),
  ]);
  const chain: ResolvedExecutionChain = {
    ...(primaryProbe?.available && primary ? { backend: primary } : {}),
    ...(omniparserProbe.available ? { omniparser } : {}),
    probe:
      primaryProbe?.available
        ? primaryProbe
        : omniparserProbe.available
          ? omniparserProbe
          : {
              id: "native" as const,
              available: true,
              detail: "Traditional platform layer",
            },
  };
  return chain;
}

export async function resolveExecutionBackend(
  options: ExecutionBackendOptions = {},
): Promise<{ backend: ExecutionBackend | undefined; probe: ExecutionBackendProbe }> {
  const chain = await resolveExecutionChain(options);
  return { backend: chain.backend ?? chain.omniparser, probe: chain.probe };
}

function execFileToResult(
  implementation: typeof execFile,
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<GlobalCommandResult> {
  return new Promise((resolve, reject) => {
    implementation(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function parseElementObservation(
  stdout: string,
): ElementObservation {
  const elements: ExecutionElement[] = [];
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    collectElements(parsed, elements);
  } catch {
    // Non-JSON output (or an empty tree) means no usable elements.
  }
  return { elements, capturedAt: new Date().toISOString() };
}

function collectElements(
  node: Record<string, unknown>,
  out: ExecutionElement[],
  visited = new Set<unknown>(),
): void {
  if (visited.has(node)) return;
  visited.add(node);
  if (typeof node.id === "string" && node.id) {
    const element: ExecutionElement = { id: node.id };
    if (typeof node.label === "string") element.label = node.label;
    if (typeof node.role === "string") element.role = node.role;
    if (typeof node.name === "string" && !element.label) {
      element.label = node.name;
    }
    const frame = node.frame ?? node.bounds ?? node.rect;
    if (frame && typeof frame === "object") {
      const record = frame as Record<string, unknown>;
      const x = Number(record.x ?? record.left ?? 0);
      const y = Number(record.y ?? record.top ?? 0);
      const width = Number(record.width ?? record.w ?? 0);
      const height = Number(record.height ?? record.h ?? 0);
      if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
        element.frame = { x, y, width, height };
      }
    }
    if (typeof node.interactable === "boolean") {
      element.interactable = node.interactable;
    }
    out.push(element);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          collectElements(item as Record<string, unknown>, out, visited);
        }
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      collectElements(value as Record<string, unknown>, out, visited);
    }
  }
}

/** Best-effort desktop screenshot for the OmniParser fallback. */
export async function captureScreenshot(
  _application?: string,
  temporaryDirectory: string = tmpdir(),
): Promise<string | undefined> {
  const directory = await mkdtemp(join(temporaryDirectory, "lhic-screen-"));
  const outputPath = join(directory, "screen.png");
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "screencapture",
          ["-x", outputPath],
          { timeout: 10_000 },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    } else if (platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Add-Type -AssemblyName System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save('${outputPath.replace(/'/g, "''")}'); $g.Dispose(); $bmp.Dispose()`,
          ],
          { timeout: 10_000, windowsHide: true },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        execFile(
          "import",
          ["-window", "root", outputPath],
          { timeout: 10_000 },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
    return outputPath;
  } catch {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return undefined;
  }
}

const peekabooKeyMap: Record<string, string> = {
  enter: "Return",
  return: "Return",
  escape: "Escape",
  esc: "Escape",
  space: "Space",
  tab: "Tab",
  up: "Up Arrow",
  down: "Down Arrow",
  left: "Left Arrow",
  right: "Right Arrow",
};

async function macOsVersion(
  implementation: typeof execFile,
): Promise<{ major: number; label: string } | undefined> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      implementation(
        "sw_vers",
        ["-productVersion"],
        { timeout: 5_000 },
        (error, out) => (error ? reject(error) : resolve(String(out))),
      );
    });
    const major = Number(stdout.trim().split(".")[0]);
    if (!Number.isFinite(major)) return undefined;
    return { major, label: stdout.trim() };
  } catch {
    return undefined;
  }
}

async function windowsVersion(
  implementation: typeof execFile,
): Promise<{ major: number; build: number; label: string } | undefined> {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      implementation(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Write-Output ([System.Environment]::OSVersion.Version.ToString())",
        ],
        { timeout: 5_000, windowsHide: true },
        (error, out) => (error ? reject(error) : resolve(String(out))),
      );
    });
    const parts = stdout.trim().split(".").map(Number);
    if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) {
      return undefined;
    }
    return {
      major: parts[0]!,
      build: Number.isFinite(parts[2]) ? parts[2]! : 0,
      label: stdout.trim(),
    };
  } catch {
    return undefined;
  }
}

export function normalizePressKey(key: string): string {
  const parts = key.split("+").map((part) => part.trim());
  return parts
    .map((part) => {
      const lower = part.toLocaleLowerCase();
      if (peekabooKeyMap[lower]) return peekabooKeyMap[lower];
      if (lower === "cmd" || lower === "command") return "cmd";
      if (lower === "ctrl" || lower === "control") return "ctrl";
      if (lower === "alt" || lower === "option") return "alt";
      if (lower === "shift") return "shift";
      return part.length === 1 ? part : part[0]!.toUpperCase() + part.slice(1);
    })
    .join("+");
}
