import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import {
  gameTrainingPaths,
  createGamePolicyPackage,
  verifyGamePolicyPackage,
  getGameTargetProfile,
  inspectGameTrainingEnvironment,
  recordDesktopHumanPlay,
  setupGameTrainingEnvironment,
  type GameTargetProfile,
} from "@lhic/game-training";
import {
  ExecFileGlobalCommandRunner,
  getGlobalDesktopPlatform,
  inspectActiveGlobalDesktop,
} from "@lhic/skills";

import type {
  GameProfile,
  PolicyPackage,
  PolicyPackageRequest,
  PolicyPackageSubmission,
  GameTrainingEnvironment,
  GameTrainingRequest,
  TrainingJob,
} from "../shared/contracts.js";
import { validateCustomGameProfile } from "../shared/policy.js";
import { spawnProcess, type SpawnedProcess } from "./process-runner.js";

const supportedProfileIds = new Set([
  "star-trooper",
  "nemesis",
  "epic-shooter-3d",
]);

type HumanRecorder = typeof recordDesktopHumanPlay;

interface GameServiceOptions {
  recordHumanPlay?: HumanRecorder;
  assertFocused?: (windowTitle: string) => Promise<void>;
  inspectRuntime?: (python: string) => Promise<GameTrainingEnvironment>;
  prepareRuntime?: (options: {
    environmentRoot: string;
  }) => Promise<GameTrainingEnvironment>;
}

/**
 * Owns local human-play recording jobs. The desktop application never shells
 * out to a globally installed CLI and never grants a model access to frames or
 * desktop input.
 */
export class GameService {
  private readonly jobs = new Map<string, TrainingJob>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly processes = new Map<string, SpawnedProcess>();
  private readonly listeners = new Set<(job: TrainingJob) => void>();
  private readonly recordHumanPlay: HumanRecorder;
  private readonly assertFocused: (windowTitle: string) => Promise<void>;
  private readonly inspectRuntime: (
    python: string,
  ) => Promise<GameTrainingEnvironment>;
  private readonly prepareRuntime: (options: {
    environmentRoot: string;
  }) => Promise<GameTrainingEnvironment>;

  public constructor(options: GameServiceOptions = {}) {
    this.recordHumanPlay = options.recordHumanPlay ?? recordDesktopHumanPlay;
    this.assertFocused = options.assertFocused ?? assertFocusedGameWindow;
    this.inspectRuntime =
      options.inspectRuntime ?? inspectGameTrainingEnvironment;
    this.prepareRuntime =
      options.prepareRuntime ?? setupGameTrainingEnvironment;
  }

  public inspectEnvironment(
    workspaceRoot: string,
  ): Promise<GameTrainingEnvironment> {
    return this.inspectRuntime(this.environmentPython(workspaceRoot));
  }

  public prepareEnvironment(
    workspaceRoot: string,
  ): Promise<GameTrainingEnvironment> {
    return this.prepareRuntime({
      environmentRoot: gameTrainingPaths("2d", this.root(workspaceRoot))
        .environmentRoot,
    });
  }

  public validate(profile: GameProfile): GameProfile {
    return validateCustomGameProfile(profile);
  }

  public async packagePolicy(
    input: PolicyPackageRequest,
    workspaceRoot: string,
  ): Promise<PolicyPackage> {
    const created = await createGamePolicyPackage({
      artifactPath: requiredWorkspacePath(input.artifactPath, workspaceRoot),
      destinationDirectory: requiredWorkspacePath(
        input.destinationDirectory,
        workspaceRoot,
      ),
      ...(input.evaluationReportPath
        ? {
            evaluationReportPath: requiredWorkspacePath(
              input.evaluationReportPath,
              workspaceRoot,
            ),
          }
        : {}),
    });
    return {
      packageId: created.manifest.packageId,
      core: created.manifest.core,
      profileId: created.manifest.profileId,
      artifactPath: created.artifactPath,
      manifestPath: created.manifestPath,
      bundlePath: created.bundlePath,
      ...(created.reportPath ? { reportPath: created.reportPath } : {}),
      actionCodec: created.manifest.actionMapping.codec,
      weightsSha256: created.manifest.files.weights.sha256,
      manifestSha256: createHash("sha256")
        .update(await readFile(created.manifestPath))
        .digest("hex"),
      bundleSha256: created.bundleSha256,
      ...(created.manifest.files.evaluationReport
        ? {
            evaluationReportSha256:
              created.manifest.files.evaluationReport.sha256,
          }
        : {}),
      status: "local",
      createdAt: created.manifest.createdAt,
    };
  }

  /**
   * Rebuilds submission metadata from the local package instead of accepting
   * renderer-supplied paths, digests, or policy fields as authoritative.
   */
  public async preparePolicySubmission(
    input: PolicyPackageSubmission,
    workspaceRoot: string,
  ): Promise<PolicyPackageSubmission> {
    if (input.package.status !== "local") {
      throw new Error(
        "Only an unsubmitted local policy package can be submitted.",
      );
    }
    const manifestPath = requiredWorkspacePath(
      input.package.manifestPath,
      workspaceRoot,
    );
    const bundlePath = requiredWorkspacePath(
      input.package.bundlePath,
      workspaceRoot,
    );
    const verified = await verifyGamePolicyPackage({
      manifestPath,
      bundlePath,
    });
    const localPackage: PolicyPackage = {
      packageId: verified.manifest.packageId,
      core: verified.manifest.core,
      profileId: verified.manifest.profileId,
      artifactPath: verified.artifactPath,
      manifestPath: verified.manifestPath,
      bundlePath: verified.bundlePath,
      ...(verified.reportPath ? { reportPath: verified.reportPath } : {}),
      actionCodec: verified.manifest.actionMapping.codec,
      weightsSha256: verified.manifest.files.weights.sha256,
      manifestSha256: verified.manifestSha256,
      bundleSha256: verified.bundleSha256,
      ...(verified.manifest.files.evaluationReport
        ? {
            evaluationReportSha256:
              verified.manifest.files.evaluationReport.sha256,
          }
        : {}),
      status: "local",
      createdAt: verified.manifest.createdAt,
    };
    return {
      package: localPackage,
      bundleUrl: input.bundleUrl,
      version: input.version,
    };
  }

  public async run(
    input: GameTrainingRequest,
    workspaceRoot: string,
  ): Promise<TrainingJob> {
    if (input.action !== "record") {
      return this.runEmbeddedRuntime(input, workspaceRoot);
    }
    const profile = this.resolveProfile(input);
    const captureRegion = requiredCaptureRegion(input.captureRegion);
    const windowTitle = requiredText(input.windowTitle, "game window title");
    const approvedBy = requiredText(input.approvedBy, "operator identity");
    const durationMs = input.durationMs ?? 30_000;
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs < 1_000 ||
      durationMs > 5 * 60_000
    ) {
      throw new Error(
        "Recording duration must be between 1 second and 5 minutes.",
      );
    }
    const environment = await this.inspectEnvironment(workspaceRoot);
    if (!environment.ready) {
      throw new Error(
        environment.detail ??
          "The local Game Lab runtime is not ready. Prepare it before recording.",
      );
    }

    const id = randomUUID();
    const cancellation = new AbortController();
    const job: TrainingJob = {
      id,
      kind: "game-record",
      status: "running",
      startedAt: new Date().toISOString(),
      command: ["desktop", "game", "record", profile.id],
    };
    this.update(job);
    this.cancellations.set(id, cancellation);

    void this.recordHumanPlay({
      profile,
      root: this.root(workspaceRoot),
      windowTitle,
      captureRegion,
      approvedBy,
      durationMs,
      actionCodec:
        profile.core === "2d" ? "game-2d-action-v1" : "game-3d-fps-action-v1",
      preprocessingVersion:
        profile.core === "2d"
          ? "game-2d-rgb-128-history-2-v1"
          : "game-3d-rgb-96-history-4-v1",
      signal: cancellation.signal,
      assertFocused: () => this.assertFocused(windowTitle),
    }).then(
      (report) =>
        this.complete(id, {
          dataset: report.datasetPath,
          trace: report.tracePath,
          sampleCount: report.sampleCount,
          lease: report.lease,
          realtime: report.realtime,
          localOnly: true,
        }),
      (error) => this.fail(id, error),
    );
    return job;
  }

  public cancel(id: string): void {
    const cancellation = this.cancellations.get(id);
    cancellation?.abort();
    this.processes.get(id)?.child.kill("SIGTERM");
    const job = this.jobs.get(id);
    if (job?.status === "running") {
      this.update({
        ...job,
        status: "cancelled",
        finishedAt: new Date().toISOString(),
      });
    }
  }

  public status(id: string): TrainingJob {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error("The requested game training job does not exist.");
    }
    return { ...job, command: [...job.command] };
  }

  public subscribe(listener: (job: TrainingJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public runningCount(): number {
    return [...this.jobs.values()].filter((job) => job.status === "running")
      .length;
  }

  private resolveProfile(input: GameTrainingRequest): GameTargetProfile {
    if (input.profileId !== "custom") {
      if (!supportedProfileIds.has(input.profileId)) {
        throw new Error("Game target is unsupported.");
      }
      const profile = getGameTargetProfile(input.profileId);
      if (profile.core !== input.core) {
        throw new Error("Game core does not match the selected target.");
      }
      return profile;
    }
    if (!input.customProfile) {
      throw new Error(
        "A custom recording requires a validated custom profile.",
      );
    }
    const custom = validateCustomGameProfile(input.customProfile);
    return {
      id: `custom-${safeProfileId(custom.id)}`,
      core: input.core,
      title: custom.title,
      sourceRepository: "operator-attested-local-target",
      supportedSurfaces: ["desktop"],
      viewport: {
        width: custom.captureRegion?.width ?? 1280,
        height: custom.captureRegion?.height ?? 720,
      },
      control: {
        allowedKeys: custom.allowedKeys,
        allowPrimaryClick: custom.allowPrimaryClick,
        aimMode: input.core === "3d" ? "relative" : "none",
        ...(input.core === "3d" ? { maxPointerDelta: 48 } : {}),
      },
      telemetry: {},
      frameRate: input.core === "2d" ? 20 : 15,
    };
  }

  private complete(id: string, report: Record<string, unknown>): void {
    this.cancellations.delete(id);
    this.processes.delete(id);
    const job = this.jobs.get(id);
    if (!job || job.status === "cancelled") return;
    this.update({
      ...job,
      status: "completed",
      finishedAt: new Date().toISOString(),
      report,
    });
  }

  private environmentPython(workspaceRoot: string): string {
    const environmentRoot = gameTrainingPaths(
      "2d",
      this.root(workspaceRoot),
    ).environmentRoot;
    return process.platform === "win32"
      ? `${environmentRoot}\\Scripts\\python.exe`
      : `${environmentRoot}/bin/python`;
  }

  private root(workspaceRoot: string): string {
    return join(workspaceRoot, ".lhic/game-training");
  }

  private fail(id: string, error: unknown): void {
    this.cancellations.delete(id);
    this.processes.delete(id);
    const job = this.jobs.get(id);
    if (!job || job.status === "cancelled") return;
    this.update({
      ...job,
      status: "failed",
      finishedAt: new Date().toISOString(),
      report: {
        error: redactText(
          error instanceof Error ? error.message : String(error),
        ),
      },
    });
  }

  private async runEmbeddedRuntime(
    input: GameTrainingRequest,
    workspaceRoot: string,
  ): Promise<TrainingJob> {
    if (input.profileId === "custom") {
      throw new Error(
        "Custom Game profiles support local human-play recording only.",
      );
    }
    const profile = this.resolveProfile(input);
    if (["fit", "evaluate", "play"].includes(input.action)) {
      const environment = await this.inspectEnvironment(workspaceRoot);
      if (!environment.ready) {
        throw new Error(
          environment.detail ??
            "The local Game Lab runtime is not ready. Prepare it before training or playback.",
        );
      }
    }
    const argumentsList = createEmbeddedGameTrainingArguments(
      input,
      profile,
      workspaceRoot,
    );
    const id = randomUUID();
    const job: TrainingJob = {
      id,
      kind: embeddedJobKind(input.action),
      status: "running",
      startedAt: new Date().toISOString(),
      command: ["desktop", "game", input.action, profile.id],
    };
    this.update(job);
    const worker = spawnProcess(
      process.execPath,
      [
        join(import.meta.dirname, "game-cli-worker.js"),
        JSON.stringify(argumentsList),
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    this.processes.set(id, worker);
    void worker.completed.then(
      (result) => {
        const current = this.jobs.get(id);
        this.processes.delete(id);
        if (!current || current.status === "cancelled") return;
        if (result.exitCode === 0) {
          this.update({
            ...current,
            status: "completed",
            finishedAt: new Date().toISOString(),
            report: workerReport(result.stdout),
          });
          return;
        }
        this.update({
          ...current,
          status: "failed",
          finishedAt: new Date().toISOString(),
          report: { error: redactText(result.stderr || result.stdout) },
        });
      },
      (error) => this.fail(id, error),
    );
    return job;
  }

  private update(job: TrainingJob): void {
    const snapshot: TrainingJob = {
      ...job,
      command: [...job.command],
      ...(job.report ? { report: { ...job.report } } : {}),
    };
    this.jobs.set(job.id, snapshot);
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createEmbeddedGameTrainingArguments(
  input: GameTrainingRequest,
  profile: GameTargetProfile,
  workspaceRoot: string,
): string[] {
  const root = join(workspaceRoot, ".lhic/game-training");
  const argumentsList = [
    profile.core,
    input.action,
    profile.id,
    "--root",
    root,
  ];
  switch (input.action) {
    case "setup":
      if (profile.targetOrigin?.kind === "local") {
        argumentsList.push(
          "--source",
          requiredWorkspacePath(input.resourcePath, workspaceRoot),
        );
      }
      return argumentsList;
    case "lease": {
      const captureRegion = requiredCaptureRegion(input.captureRegion);
      argumentsList.push(
        "--window-title",
        requiredText(input.windowTitle, "game window title"),
        "--region",
        `${captureRegion.x},${captureRegion.y},${captureRegion.width},${captureRegion.height}`,
        "--approved-by",
        requiredText(input.approvedBy, "operator identity"),
        "--output",
        join(root, "leases", `${profile.id}.json`),
      );
      return argumentsList;
    }
    case "fit":
      argumentsList.push(
        "--dataset",
        requiredWorkspacePath(input.resourcePath, workspaceRoot),
      );
      return argumentsList;
    case "evaluate":
    case "play":
      argumentsList.push(
        "--artifact",
        requiredWorkspacePath(input.resourcePath, workspaceRoot),
      );
      return argumentsList;
    case "record":
      throw new Error("Human-play recording uses the direct desktop recorder.");
  }
}

function embeddedJobKind(
  action: GameTrainingRequest["action"],
): TrainingJob["kind"] {
  switch (action) {
    case "setup":
    case "lease":
      return "game-setup";
    case "fit":
      return "game-fit";
    case "evaluate":
      return "game-evaluate";
    case "play":
      return "game-play";
    case "record":
      return "game-record";
  }
}

function requiredWorkspacePath(
  value: string | undefined,
  workspaceRoot: string,
): string {
  const raw = requiredText(value, "local resource path");
  if (raw.includes("\0")) {
    throw new Error("Local resource paths may not contain NUL bytes.");
  }
  const root = resolve(workspaceRoot);
  const candidate = resolve(root, raw);
  const relativePath = relative(root, candidate);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error("Game resources must remain inside the active workspace.");
  }
  return candidate;
}

function workerReport(output: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Game worker returned an invalid report.");
    }
    return redactReport(parsed as Record<string, unknown>);
  } catch {
    return { output: redactText(output).slice(0, 4_000) };
  }
}

function redactReport(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      /(?:key|secret|token|password|cookie)/i.test(key)
        ? "[REDACTED]"
        : typeof item === "string"
          ? redactText(item)
          : item,
    ]),
  );
}

async function assertFocusedGameWindow(windowTitle: string): Promise<void> {
  const state = await inspectActiveGlobalDesktop(
    new ExecFileGlobalCommandRunner(),
    getGlobalDesktopPlatform(),
  );
  if (state.title?.trim() !== windowTitle.trim()) {
    throw new Error("The approved game window is no longer focused.");
  }
}

function requiredCaptureRegion(value: GameTrainingRequest["captureRegion"]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (
    !value ||
    ![value.x, value.y, value.width, value.height].every(
      Number.isSafeInteger,
    ) ||
    value.x < 0 ||
    value.y < 0 ||
    value.width < 1 ||
    value.height < 1
  ) {
    throw new Error("A valid desktop capture region is required.");
  }
  return { ...value };
}

function requiredText(value: string | undefined, label: string): string {
  if (!value?.trim() || value.length > 256) {
    throw new Error(`A valid ${label} is required.`);
  }
  return value.trim();
}

function safeProfileId(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}

function redactText(value: string): string {
  return value
    .replace(
      /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED_TOKEN]",
    )
    .slice(0, 1_000);
}
