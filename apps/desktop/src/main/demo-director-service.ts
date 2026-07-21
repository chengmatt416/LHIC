import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import type { GlobalComputerAction } from "@lhic/schema";
import { createActionApproval, signActionApproval } from "@lhic/security";
import { GlobalComputerExecutor } from "@lhic/skills";

import type {
  DemoCandidateStatus,
  DemoCodexDispatchRequest,
  DemoCodexRunStatus,
  DemoDirectorResult,
  DemoRecordingClipResult,
  DemoRecordingStatus,
} from "../shared/contracts.js";
import { DemoTerminalService } from "./demo-terminal-service.js";
import { ensurePrivateDirectory } from "./private-directory.js";

const challengeApplication =
  "/Applications/Launcher.app/Contents/Resources/GameBuilds/Challenge2026.app";
const vendorOrigin = "https://vendor.techtools.qzz.io";

export class DemoDirectorService {
  private readonly signingKeys = generateKeyPairSync("ed25519");
  private readonly scenario = loadScenario(process.env);
  private recorder: ChildProcess | undefined;
  private recording: DemoRecordingStatus = { recording: false };
  private readonly terminal: DemoTerminalService;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly focusLhicWindow: () => boolean,
    terminal?: DemoTerminalService,
  ) {
    this.terminal = terminal ?? new DemoTerminalService(workspaceRoot);
  }

  public signingCertificateSha256(): string {
    return createHash("sha256")
      .update(
        this.signingKeys.publicKey.export({ type: "spki", format: "der" }),
      )
      .digest("hex");
  }

  public codexAvailable(): boolean {
    return (
      process.platform === "darwin" &&
      (existsSync("/Applications/Codex.app/Contents/Resources/codex") ||
        existsSync("/Applications/ChatGPT.app/Contents/Resources/codex"))
    );
  }

  public challengeAvailable(): boolean {
    return process.platform === "darwin" && existsSync(challengeApplication);
  }

  public recorderAvailable(): boolean {
    return (
      process.platform === "darwin" && existsSync("/usr/sbin/screencapture")
    );
  }

  public scenarioReady(): boolean {
    return [
      this.scenario.slowEmployee,
      this.scenario.slowManager,
      this.scenario.fastEmployee,
      this.scenario.fastManager,
    ].every((value) => value.length > 0);
  }

  public codexModel(): string {
    return this.scenario.model;
  }

  public codexApplicationLabel(): string {
    return "Codex CLI in Terminal";
  }

  public fastGoal(): string {
    this.requireScenario();
    return `Fast Path only: on the vendor site, order Test3 ×2 and Test2 ×1 using employee number ${this.scenario.fastEmployee}; add the matching 進貨支出 using manager employee number ${this.scenario.fastManager}; increase Test stock to 21. Do not call an LLM or MCP. Require normal human approval and verifier evidence.`;
  }

  public async dispatchCodex(
    input: DemoCodexDispatchRequest,
  ): Promise<DemoDirectorResult> {
    const startedAt = performance.now();
    const evidence: string[] = [];
    try {
      validateCodexRequest(input);
      this.requireScenario();
      if (!this.codexAvailable()) {
        throw new Error("The Codex CLI was not found in /Applications.");
      }
      await ensurePrivateDirectory(resolve(this.workspaceRoot, ".lhic/traces"));
      const executable = await this.terminal.launchCodex(
        slowPrompt(this.scenario),
        this.scenario.model,
        "medium",
      );
      evidence.push(
        `Launched ${executable} in Terminal with ${this.scenario.model} at medium reasoning effort.`,
        "The submitted prompt delegates browser work to LHIC MCP; Codex receives no direct browser-control permission.",
        "Codex CLI confirmation prompts and its sandbox are explicitly bypassed for this demonstration; LHIC policy, signing, and verifier gates remain active.",
        "Terminal owns focus so the recording captures the live Codex CLI transcript.",
      );
      return completed(startedAt, evidence);
    } catch (error) {
      this.focusLhicWindow();
      return failed(startedAt, evidence, safeError(error));
    }
  }

  public async approveCodexPermission(
    approvedBy: string,
  ): Promise<DemoDirectorResult> {
    const startedAt = performance.now();
    const evidence: string[] = [];
    try {
      if (!approvedBy.trim()) {
        throw new Error("Demo permission approval requires an approver.");
      }
      await this.terminal.focus();
      evidence.push(
        "Focused Terminal without using Codex desktop Accessibility selectors.",
        "Codex CLI is running with its dangerous permission bypass; LHIC still enforces its own action policy.",
      );
      return completed(startedAt, evidence);
    } catch (error) {
      this.focusLhicWindow();
      return failed(startedAt, evidence, safeError(error));
    }
  }

  public codexRunStatus(): Promise<DemoCodexRunStatus> {
    return this.terminal.codexRunStatus();
  }

  public focusLhic(): DemoDirectorResult {
    const startedAt = performance.now();
    const focused = this.focusLhicWindow();
    return focused
      ? completed(startedAt, ["Verified the LHIC control window is focused."])
      : failed(startedAt, [], "The LHIC control window could not be focused.");
  }

  public async showFastPathTerminal(commandId: string): Promise<void> {
    await this.terminal.launchFastPathMonitor(commandId);
  }

  public async focusTerminal(): Promise<void> {
    await this.terminal.focus();
  }

  public async launchChallenge(): Promise<DemoDirectorResult> {
    const startedAt = performance.now();
    if (!this.challengeAvailable()) {
      return failed(
        startedAt,
        [],
        "Challenge2026.app was not found in the configured Launcher bundle.",
      );
    }
    const action: GlobalComputerAction = {
      scope: "os",
      type: "os_launch",
      intent: "Launch the approved local Challenge 2026 game",
      application: challengeApplication,
      methodPreference: ["accessibility"],
      riskLevel: "medium",
      verifier: { type: "process_running", application: "Challenge2026" },
    };
    await ensurePrivateDirectory(resolve(this.workspaceRoot, ".lhic/traces"));
    const executor = new GlobalComputerExecutor({
      taskId: `demo-game-${Date.now()}`,
      traceFilePath: resolve(
        this.workspaceRoot,
        ".lhic/traces/demo-director-game.jsonl",
      ),
      approvalValidation: {
        requireSignature: true,
        publicKey: this.signingKeys.publicKey,
      },
    });
    const approval = signActionApproval(
      createActionApproval(action, "demo-operator"),
      this.signingKeys.privateKey,
    );
    const result = await executor.execute(action, approval);
    return result.success
      ? completed(startedAt, [
          ...result.evidence,
          "Challenge 2026 was launched as the approved native target; Game Lab remains responsible for policy play and focus checks.",
        ])
      : failed(
          startedAt,
          result.evidence,
          result.error ?? "Game launch failed.",
        );
  }

  public async candidates(): Promise<DemoCandidateStatus[]> {
    const databasePath = resolve(this.workspaceRoot, ".lhic/skills.sqlite");
    await ensurePrivateDirectory(dirname(databasePath));
    const database = createMemoryDatabase(databasePath);
    try {
      return new SkillStore(database)
        .listCandidates()
        .filter((candidate) =>
          isVendorCandidateDefinition(candidate.definition),
        )
        .map((candidate) => ({
          name: candidate.name,
          verifiedRunCount: candidate.verifiedRunCount,
          holdoutPassed: candidate.holdoutPassed,
          promoted: candidate.promoted,
        }));
    } finally {
      database.close();
    }
  }

  public async startRecording(): Promise<DemoRecordingStatus> {
    if (this.recorder) return this.recording;
    if (!this.recorderAvailable()) {
      throw new Error("The macOS screen recorder is unavailable.");
    }
    const directory = demoRecordingDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const outputPath = join(directory, `lhic-demo-${fileTimestamp()}.mov`);
    const startedAt = new Date().toISOString();
    const recorder = spawn(
      "/usr/sbin/screencapture",
      ["-v", "-D1", "-k", outputPath],
      { stdio: "ignore" },
    );
    recorder.once("exit", () => {
      if (this.recorder === recorder) {
        this.recorder = undefined;
        this.recording = { recording: false, startedAt, outputPath };
      }
    });
    this.recorder = recorder;
    this.recording = { recording: true, startedAt, outputPath };
    return this.recording;
  }

  public async stopRecording(): Promise<DemoRecordingStatus> {
    const recorder = this.recorder;
    if (!recorder) return this.recording;
    await new Promise<void>((resolveExit) => {
      const timeout = setTimeout(() => {
        recorder.kill("SIGTERM");
        resolveExit();
      }, 5_000);
      recorder.once("exit", () => {
        clearTimeout(timeout);
        resolveExit();
      });
      recorder.kill("SIGINT");
    });
    this.recorder = undefined;
    this.recording = { ...this.recording, recording: false };
    return this.recording;
  }

  public async saveRecordingClip(): Promise<DemoRecordingClipResult> {
    if (!this.recorder || !this.recording.recording) {
      throw new Error(
        "A recording must be running before a clip can be saved.",
      );
    }
    const stopped = await this.stopRecording();
    if (!stopped.outputPath) {
      throw new Error("The completed recording clip has no output path.");
    }
    const recording = await this.startRecording();
    return { savedClipPath: stopped.outputPath, recording };
  }

  public recordingStatus(): DemoRecordingStatus {
    return this.recording;
  }

  private requireScenario(): void {
    if (!this.scenarioReady()) {
      throw new Error(
        "Demo identities are not configured. Set LHIC_DEMO_SLOW_EMPLOYEE, LHIC_DEMO_SLOW_MANAGER, LHIC_DEMO_FAST_EMPLOYEE, and LHIC_DEMO_FAST_MANAGER before launch.",
      );
    }
  }
}

export function demoRecordingDirectory(homeDirectory = homedir()): string {
  return resolve(homeDirectory, "Downloads");
}

export function isVendorCandidateDefinition(
  definition: Record<string, unknown>,
): boolean {
  if (definition.origin === vendorOrigin) return true;
  const plan = definition.plan;
  if (!plan || typeof plan !== "object") {
    return false;
  }
  const steps = (plan as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return false;
  return steps.some((step: unknown) => {
    if (!step || typeof step !== "object") return false;
    const action = (step as Record<string, unknown>).action;
    if (!action || typeof action !== "object") return false;
    const target = (action as Record<string, unknown>).target;
    if (typeof target !== "string") return false;
    try {
      return new URL(target).origin === vendorOrigin;
    } catch {
      return false;
    }
  });
}

interface DemoScenario {
  model: string;
  slowEmployee: string;
  slowManager: string;
  fastEmployee: string;
  fastManager: string;
}

function validateCodexRequest(input: DemoCodexDispatchRequest): void {
  if (!input.approvedBy.trim()) {
    throw new Error("Demo Codex approver is required.");
  }
}

function loadScenario(environment: NodeJS.ProcessEnv): DemoScenario {
  return {
    model: environment.LHIC_DEMO_CODEX_MODEL?.trim() || "gpt-5.6-luna",
    slowEmployee: environment.LHIC_DEMO_SLOW_EMPLOYEE?.trim() || "LHICTEST",
    slowManager: environment.LHIC_DEMO_SLOW_MANAGER?.trim() || "LHICMANAGER",
    fastEmployee: environment.LHIC_DEMO_FAST_EMPLOYEE?.trim() || "LHICTEST2",
    fastManager: environment.LHIC_DEMO_FAST_MANAGER?.trim() || "LHICMANAGER2",
  };
}

function slowPrompt(scenario: DemoScenario): string {
  return `Use only the connected LHIC MCP tools for every computer action. Do not use Codex computer-use or direct browser-control abilities. Submit the complete workflow through lhic_browser_execute_plan so LHIC can retain one verifier-backed candidate after every step succeeds. Open https://vendor.techtools.qzz.io/. Order Test3 ×1 and Test2 ×2 using employee number ${scenario.slowEmployee}. Add a 進貨支出 on /finance using manager employee number ${scenario.slowManager}, and increase Test stock to 20. When LHIC opens its native human-permission dialog, keep the current MCP tool call pending and wait for the operator; do not summarize, close the browser, or end the task. After approval, continue the remaining finance and stock steps. Let LHIC produce verifier evidence after each action and record the completed Slow Path as a candidate only; do not bypass the three-run and unseen-UI holdout promotion gates.`;
}

function completed(startedAt: number, evidence: string[]): DemoDirectorResult {
  return {
    status: "completed",
    durationMs: Math.round(performance.now() - startedAt),
    evidence,
  };
}

function failed(
  startedAt: number,
  evidence: string[],
  error: string,
): DemoDirectorResult {
  return {
    status: "failed",
    durationMs: Math.round(performance.now() - startedAt),
    evidence,
    error,
  };
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500)
    : "The approved demo action failed.";
}

function fileTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}
