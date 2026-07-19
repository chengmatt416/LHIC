import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  assertArtifactCompatible,
  assertGamePolicyWeights,
  appendGameTrainingTrace,
  createGameControlLease,
  createGameEpisodeSample,
  createSeededRandomInitScript,
  GameFramePacer,
  gameTargetProfileDigest,
  gameTrainingPaths,
  getGameTargetProfile,
  readGameDatasetManifest,
  readGamePolicyArtifact,
  readRegisteredLocalGameTarget,
  readRegisteredRemoteGameTarget,
  registerLocalGameTarget,
  registerRemoteGameTarget,
  runPythonDesktopWorker,
  runPythonTraining,
  inspectGameTrainingEnvironment,
  startPythonDesktopRecordingSession,
  startPythonPolicySession,
  setupGameTrainingEnvironment,
  startLocalGameTargetServer,
  validateGameControlLease,
  writeGameDatasetManifest,
  writeGamePolicyArtifact,
  type GameControlLease,
  type GameCaptureRegion,
  type GameCoreId,
  type GameDatasetManifest,
  type GameInputSample,
  type GamePolicyArtifact,
  type GameRealtimeMetrics,
  type GameTargetProfile,
  type GameTraceMetadata,
  type PythonDesktopInput,
} from "@lhic/game-training";
import {
  game2dActionCodec,
  game2dFrameSpec,
  game2dPreprocessingVersion,
  randomGame2dAction,
} from "@lhic/game-training-2d";
import {
  game3dActionCodec,
  game3dFrameSpec,
  game3dPreprocessingVersion,
  randomGame3dAction,
} from "@lhic/game-training-3d";
import { chromium, type BrowserContext, type Page } from "playwright";
import {
  ExecFileGlobalCommandRunner,
  getGlobalDesktopPlatform,
  inspectActiveGlobalDesktop,
} from "@lhic/skills";

type CoreGameAction = {
  movement: string[];
  fire: boolean;
  aim?: { x: number; y: number };
  look?: { deltaX: number; deltaY: number };
};

export interface GameTrainingReport {
  command: string;
  core?: GameCoreId;
  profile?: string;
  [key: string]: unknown;
}

interface GameExecutionTrace {
  root: string;
  metadata: GameTraceMetadata;
}

interface BrowserGameTarget {
  url: string;
  allowedOrigins: readonly string[];
  supportsInjectedSeed: boolean;
  close(): Promise<void>;
}

interface BrowserRecording {
  samples: GameDatasetManifest["samples"];
  realtime: GameRealtimeMetrics;
}

interface BrowserEpisodeResult {
  score: number;
  realtime: GameRealtimeMetrics;
}

interface GameDatasetQuality {
  sampleCount: number;
  durationMs: number;
  captureRateHz: number;
  movementActionCount: number;
  fireSampleCount: number;
  lookSampleCount: number;
}

export async function runGameTrainingCommand(
  argumentsList: string[],
): Promise<GameTrainingReport> {
  const [scope, action, profileId, ...options] = argumentsList;
  if (scope === "env") {
    return runEnvironmentCommand(action, options);
  }
  if (scope !== "2d" && scope !== "3d") {
    throw new Error("Game training requires `env`, `2d`, or `3d`.");
  }
  if (!action || !profileId) {
    throw new Error(
      "Game training requires an action and target: setup|lease|record|fit|evaluate|play <target>.",
    );
  }
  const profile = getGameTargetProfile(profileId);
  if (profile.core !== scope) {
    throw new Error(
      `${profile.id} is a ${profile.core} target, not a ${scope} target.`,
    );
  }
  const parsed = parseOptions(options);
  const root = optionString(parsed, "--root") ?? ".lhic/game-training";
  switch (action) {
    case "setup":
      return setupTarget(profile, parsed, root);
    case "lease":
      return createDesktopLease(profile, parsed);
    case "record":
      return selectedSurface(parsed) === "desktop"
        ? recordDesktopDataset(profile, parsed, root)
        : recordBrowserDataset(profile, parsed, root);
    case "fit":
      return fitPolicy(profile, parsed, root);
    case "evaluate":
      return evaluateBrowserPolicy(profile, parsed, root);
    case "play":
      return selectedSurface(parsed) === "desktop"
        ? playDesktopPolicy(profile, parsed, root)
        : playBrowserPolicy(profile, parsed, root);
    default:
      throw new Error(
        "Game-training actions are setup, lease, record, fit, evaluate, and play.",
      );
  }
}

async function runEnvironmentCommand(
  action: string | undefined,
  options: string[],
): Promise<GameTrainingReport> {
  const parsed = parseOptions(options);
  const root = optionString(parsed, "--root") ?? ".lhic/game-training";
  const paths = gameTrainingPaths("2d", root);
  const python = optionString(parsed, "--python");
  if (action === "setup") {
    const report = await setupGameTrainingEnvironment({
      environmentRoot: paths.environmentRoot,
      ...(python ? { python } : {}),
    });
    return { command: "env setup", ...report };
  }
  if (action === "doctor") {
    const executable = python ?? gameTrainingPython(paths.environmentRoot);
    const [report, desktop] = await Promise.all([
      inspectGameTrainingEnvironment(executable),
      runPythonDesktopWorker(executable, { command: "desktop-doctor" }),
    ]);
    return { command: "env doctor", ...report, desktop };
  }
  throw new Error("Game-training environment actions are setup and doctor.");
}

async function createDesktopLease(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
): Promise<GameTrainingReport> {
  const captureRegion = parseCaptureRegion(requiredOption(options, "--region"));
  const lease = createDesktopGameControlLease(
    profile.id,
    requiredOption(options, "--window-title"),
    captureRegion,
    requiredOption(options, "--approved-by"),
  );
  const output = resolve(requiredOption(options, "--output"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(lease, null, 2)}\n`, "utf8");
  return {
    command: "lease",
    core: profile.core,
    profile: profile.id,
    lease: output,
    expiresAt: lease.expiresAt,
  };
}

async function setupTarget(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  if (profile.targetOrigin?.kind === "remote") {
    if (optionString(options, "--source")) {
      throw new Error("Remote game targets do not accept --source.");
    }
    const registration = await registerRemoteGameTarget(profile, root);
    return {
      command: "setup",
      core: profile.core,
      profile: profile.id,
      target: registration,
    };
  }
  const source = requiredOption(options, "--source");
  const registration = await registerLocalGameTarget(profile, source, root);
  return {
    command: "setup",
    core: profile.core,
    profile: profile.id,
    target: registration,
  };
}

async function recordBrowserDataset(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  assertBrowserSurface(options);
  const paths = gameTrainingPaths(profile.core, root);
  const output = resolve(
    optionString(options, "--output") ??
      join(paths.datasetsRoot, `${profile.id}-${Date.now()}`),
  );
  const durationMs = boundedDuration(
    optionNumber(options, "--duration-ms") ?? 30_000,
  );
  const seed = optionInteger(options, "--seed") ?? 1;
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const framesDirectory = join(output, "frames");
  await mkdir(framesDirectory);
  const target = await openBrowserGameTarget(profile, root);
  const trace: GameExecutionTrace = {
    root,
    metadata: {
      core: profile.core,
      profileId: profile.id,
      surface: "browser",
      sessionId: randomUUID(),
    },
  };
  const browser = await chromium.launch({
    headless: optionBoolean(options, "--headless"),
  });
  try {
    await appendGameTrainingTrace(
      root,
      trace.metadata,
      "game_browser_recording_started",
      { durationMs, scripted: optionBoolean(options, "--scripted") },
    );
    const context = await browser.newContext({ viewport: profile.viewport });
    if (target.supportsInjectedSeed) {
      await context.addInitScript(createSeededRandomInitScript(seed));
    }
    await context.addInitScript(installInputRecorder);
    await restrictBrowserRequests(context, target.allowedOrigins);
    const page = await context.newPage();
    await page.goto(target.url, { waitUntil: "domcontentloaded" });
    await startProfileIfPossible(page, profile);
    await appendGameTrainingTrace(
      root,
      trace.metadata,
      "game_browser_target_ready",
    );
    const scriptedDemo = optionBoolean(options, "--scripted")
      ? runScriptedBrowserDemonstration(page, profile, durationMs)
      : undefined;
    const recording = await collectBrowserSamples(
      page,
      profile,
      framesDirectory,
      durationMs,
    );
    const { samples } = recording;
    await scriptedDemo;
    const manifest: GameDatasetManifest = {
      schemaVersion: "game-dataset-v1",
      core: profile.core,
      profileId: profile.id,
      profileDigest: gameTargetProfileDigest(profile),
      preprocessingVersion: preprocessingVersionFor(profile.core),
      actionCodec: actionCodecFor(profile.core),
      seed,
      seedMode: target.supportsInjectedSeed ? "injected" : "uncontrolled",
      surface: "browser",
      createdAt: new Date().toISOString(),
      samples,
    };
    const manifestPath = join(output, "manifest.json");
    await writeGameDatasetManifest(manifestPath, manifest);
    await appendGameTrainingTrace(
      root,
      trace.metadata,
      "game_browser_recording_completed",
      { sampleCount: samples.length, realtime: recording.realtime },
    );
    return {
      command: "record",
      core: profile.core,
      profile: profile.id,
      dataset: manifestPath,
      sampleCount: samples.length,
      datasetQuality: summarizeDatasetQuality(profile, samples),
      realtime: recording.realtime,
      trace: join(
        gameTrainingPaths(profile.core, root).tracesRoot,
        `${trace.metadata.sessionId}.jsonl`,
      ),
    };
  } catch (error) {
    await appendGameTrainingTrace(
      root,
      trace.metadata,
      "game_browser_recording_failed",
    ).catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
    await target.close();
  }
}

async function recordDesktopDataset(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  if (!profile.supportedSurfaces.includes("desktop")) {
    throw new Error(`${profile.id} is not approved for desktop recording.`);
  }
  if (profile.targetOrigin?.kind === "remote") {
    await readRegisteredRemoteGameTarget(profile, root);
  } else {
    await readRegisteredLocalGameTarget(profile, root);
  }
  const windowTitle = requiredOption(options, "--window-title");
  const captureRegion = parseCaptureRegion(requiredOption(options, "--region"));
  const lease = await readDesktopLease(requiredOption(options, "--lease"));
  assertDesktopGameControlLease(lease, profile.id, windowTitle, captureRegion);
  const durationMs = boundedDuration(
    optionNumber(options, "--duration-ms") ?? 30_000,
  );
  const seed = optionInteger(options, "--seed") ?? 1;
  const paths = gameTrainingPaths(profile.core, root);
  const output = resolve(
    optionString(options, "--output") ??
      join(paths.datasetsRoot, `${profile.id}-${Date.now()}`),
  );
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const framesDirectory = join(output, "frames");
  await mkdir(framesDirectory);
  const python =
    optionString(options, "--python") ??
    gameTrainingPython(paths.environmentRoot);
  const desktop = await runPythonDesktopWorker(python, {
    command: "desktop-doctor",
  });
  if (desktop.supported !== true) {
    throw new Error(desktop.detail ?? "Desktop game recording is unavailable.");
  }
  const trace: GameExecutionTrace = {
    root,
    metadata: {
      core: profile.core,
      profileId: profile.id,
      surface: "desktop",
      sessionId: randomUUID(),
    },
  };
  const recorder = await startPythonDesktopRecordingSession(python, {
    allowedKeys: [...profile.control.allowedKeys],
    captureRegion,
  });
  try {
    await appendGameTrainingTrace(
      root,
      trace.metadata,
      "game_desktop_recording_started",
      { durationMs },
    );
    const samples: GameDatasetManifest["samples"] = [];
    const pacer = new GameFramePacer(profile.frameRate);
    const startedAt = performance.now();
    while (performance.now() - startedAt < durationMs) {
      const frameStartedAt = pacer.startFrame();
      assertDesktopGameControlLease(
        lease,
        profile.id,
        windowTitle,
        captureRegion,
      );
      await assertFocusedGameWindow(profile, windowTitle);
      const index = String(samples.length).padStart(6, "0");
      const frameName = `${index}.png`;
      await recorder.capture(join(framesDirectory, frameName));
      const input = await recorder.readInput();
      await assertFocusedGameWindow(profile, windowTitle);
      assertDesktopGameControlLease(
        lease,
        profile.id,
        windowTitle,
        captureRegion,
      );
      samples.push(
        createGameEpisodeSample({
          timestampMs: Math.round(performance.now() - startedAt),
          frame: join("frames", frameName),
          input: desktopRecordedInput(profile, input),
          telemetry: { terminal: false },
        }),
      );
      await pacer.completeFrame(frameStartedAt);
    }
    const manifest: GameDatasetManifest = {
      schemaVersion: "game-dataset-v1",
      core: profile.core,
      profileId: profile.id,
      profileDigest: gameTargetProfileDigest(profile),
      preprocessingVersion: preprocessingVersionFor(profile.core),
      actionCodec: actionCodecFor(profile.core),
      seed,
      seedMode: "uncontrolled",
      surface: "desktop",
      captureRegion,
      createdAt: new Date().toISOString(),
      samples,
    };
    const manifestPath = join(output, "manifest.json");
    await writeGameDatasetManifest(manifestPath, manifest);
    await appendGameTrainingTrace(
      root,
      trace.metadata,
      "game_desktop_recording_completed",
      { sampleCount: samples.length, realtime: pacer.metrics() },
    );
    return {
      command: "record",
      core: profile.core,
      profile: profile.id,
      surface: "desktop",
      dataset: manifestPath,
      sampleCount: samples.length,
      datasetQuality: summarizeDatasetQuality(profile, samples),
      realtime: pacer.metrics(),
      trace: join(paths.tracesRoot, `${trace.metadata.sessionId}.jsonl`),
    };
  } catch (error) {
    await appendGameTrainingTrace(
      root,
      trace.metadata,
      "game_desktop_recording_failed",
    ).catch(() => undefined);
    throw error;
  } finally {
    await recorder.close().catch(() => undefined);
  }
}

async function fitPolicy(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  const datasetPath = resolve(requiredOption(options, "--dataset"));
  const dataset = await readGameDatasetManifest(datasetPath);
  const datasetQuality = summarizeDatasetQuality(profile, dataset.samples);
  assertDatasetTrainable(profile, datasetQuality);
  const paths = gameTrainingPaths(profile.core, root);
  const output = resolve(
    optionString(options, "--output") ??
      join(paths.skillsRoot, `${profile.id}-${Date.now()}`),
  );
  const python =
    optionString(options, "--python") ??
    gameTrainingPython(paths.environmentRoot);
  const frameSpec = frameSpecFor(profile.core);
  const actionCodec = actionCodecFor(profile.core);
  const modelType = optionString(options, "--model-type") ?? "cnn";
  const trainingSeed = optionInteger(options, "--seed") ?? dataset.seed;
  const validationSplit = optionNumber(options, "--validation-split") ?? 0.2;
  const result = await runPythonTraining(python, {
    command: "fit",
    core: profile.core,
    datasetPath,
    artifactDirectory: output,
    profileDigest: gameTargetProfileDigest(profile),
    actionCodec,
    preprocessingVersion: preprocessingVersionFor(profile.core),
    frameWidth: frameSpec.width,
    frameHeight: frameSpec.height,
    frameHistory: frameSpec.history,
    epochs: optionInteger(options, "--epochs") ?? 3,
    seed: trainingSeed,
    validationSplit,
    modelType,
  });
  if (!result.weightsFile || !result.weightsSha256) {
    throw new Error(
      "Game-training worker did not return a policy weights artifact.",
    );
  }
  const artifact: GamePolicyArtifact = {
    schemaVersion: "game-policy-v1",
    core: profile.core,
    profileId: profile.id,
    profileDigest: gameTargetProfileDigest(profile),
    preprocessingVersion: preprocessingVersionFor(profile.core),
    frameSpec,
    actionCodec,
    weightsFile: basename(result.weightsFile),
    weightsSha256: result.weightsSha256,
    modelType,
    training: {
      algorithm: "behavior-cloning-v1",
      seed: trainingSeed,
      datasetSha256: result.datasetSha256,
      validationSplit,
      trainingSampleCount: result.trainingSampleCount,
      validationSampleCount: result.validationSampleCount,
    },
    metrics: {
      behaviorCloningLoss: result.behaviorCloningLoss,
      datasetReward: result.datasetReward,
      validationLoss: result.validationLoss,
      validationActionAccuracy: result.validationActionAccuracy,
    },
    createdAt: new Date().toISOString(),
  };
  const artifactPath = join(output, "artifact.json");
  await writeGamePolicyArtifact(artifactPath, artifact);
  return {
    command: "fit",
    core: profile.core,
    profile: profile.id,
    artifact: artifactPath,
    sampleCount: result.sampleCount,
    datasetQuality,
    metrics: artifact.metrics,
  };
}

async function evaluateBrowserPolicy(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  assertBrowserSurface(options);
  const artifactPath = resolve(requiredOption(options, "--artifact"));
  const artifact = await readGamePolicyArtifact(artifactPath);
  assertArtifactCompatible(
    artifact,
    profile.core,
    profile,
    gameTargetProfileDigest(profile),
    {
      actionCodec: actionCodecFor(profile.core),
      preprocessingVersion: preprocessingVersionFor(profile.core),
      frameSpec: frameSpecFor(profile.core),
    },
  );
  const episodes = boundedEpisodes(optionInteger(options, "--episodes") ?? 10);
  const durationMs = boundedDuration(
    optionNumber(options, "--duration-ms") ?? 10_000,
  );
  const python =
    optionString(options, "--python") ??
    gameTrainingPython(gameTrainingPaths(profile.core, root).environmentRoot);
  const weightsFile = resolve(dirname(artifactPath), artifact.weightsFile);
  assertContainedPath(dirname(artifactPath), weightsFile);
  await assertGamePolicyWeights(artifact, weightsFile);
  const learnedScores: number[] = [];
  const randomScores: number[] = [];
  const learnedRealtime: GameRealtimeMetrics[] = [];
  const randomRealtime: GameRealtimeMetrics[] = [];
  const learnedFailures: Array<{ seed: number; detail: string }> = [];
  const randomFailures: Array<{ seed: number; detail: string }> = [];
  for (let seed = 0; seed < episodes; seed += 1) {
    const learnedTrace: GameExecutionTrace = {
      root,
      metadata: {
        core: profile.core,
        profileId: profile.id,
        surface: "browser",
        sessionId: randomUUID(),
      },
    };
    let policy:
      Awaited<ReturnType<typeof startPythonPolicySession>> | undefined;
    try {
      const activePolicy = await startPythonPolicySession(python, {
        core: profile.core,
        weightsFile,
        modelType: artifact.modelType,
      });
      policy = activePolicy;
      const result = await runBrowserEpisode(
        profile,
        root,
        seed,
        durationMs,
        async (frameFiles) => activePolicy.predict(frameFiles),
        false,
        learnedTrace,
      );
      learnedScores.push(result.score);
      learnedRealtime.push(result.realtime);
    } catch (error) {
      learnedFailures.push({ seed, detail: errorDetail(error) });
    } finally {
      await policy?.close().catch(() => undefined);
    }
    const random = seededRandom(seed);
    const randomTrace: GameExecutionTrace = {
      root,
      metadata: {
        core: profile.core,
        profileId: profile.id,
        surface: "browser",
        sessionId: randomUUID(),
      },
    };
    try {
      const result = await runBrowserEpisode(
        profile,
        root,
        seed,
        durationMs,
        async () => randomActionFor(profile, random),
        false,
        randomTrace,
      );
      randomScores.push(result.score);
      randomRealtime.push(result.realtime);
    } catch (error) {
      randomFailures.push({ seed, detail: errorDetail(error) });
    }
  }
  const learnedMeanScore = meanOrZero(learnedScores);
  const randomMeanScore = meanOrZero(randomScores);
  const report = {
    command: "evaluate",
    core: profile.core,
    profile: profile.id,
    episodes,
    learnedScores,
    randomScores,
    learnedFailures,
    randomFailures,
    learnedRealtime,
    randomRealtime,
    learnedAvailability: learnedScores.length / episodes,
    randomAvailability: randomScores.length / episodes,
    learnedMeanScore,
    randomMeanScore,
    deterministic: supportsInjectedSeed(profile),
    passed:
      supportsInjectedSeed(profile) &&
      learnedFailures.length === 0 &&
      randomFailures.length === 0 &&
      learnedMeanScore > 0 &&
      learnedMeanScore > randomMeanScore,
  };
  const reportPath = resolve(
    optionString(options, "--output") ??
      join(
        gameTrainingPaths(profile.core, root).reportsRoot,
        `${profile.id}-${Date.now()}.json`,
      ),
  );
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { ...report, report: reportPath };
}

async function playBrowserPolicy(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  assertBrowserSurface(options);
  const artifactPath = resolve(requiredOption(options, "--artifact"));
  const artifact = await readGamePolicyArtifact(artifactPath);
  assertArtifactCompatible(
    artifact,
    profile.core,
    profile,
    gameTargetProfileDigest(profile),
    {
      actionCodec: actionCodecFor(profile.core),
      preprocessingVersion: preprocessingVersionFor(profile.core),
      frameSpec: frameSpecFor(profile.core),
    },
  );
  const python =
    optionString(options, "--python") ??
    gameTrainingPython(gameTrainingPaths(profile.core, root).environmentRoot);
  const weightsFile = resolve(dirname(artifactPath), artifact.weightsFile);
  assertContainedPath(dirname(artifactPath), weightsFile);
  await assertGamePolicyWeights(artifact, weightsFile);
  const trace: GameExecutionTrace = {
    root,
    metadata: {
      core: profile.core,
      profileId: profile.id,
      surface: "browser",
      sessionId: randomUUID(),
    },
  };
  const policy = await startPythonPolicySession(python, {
    core: profile.core,
    weightsFile,
    modelType: artifact.modelType,
  });
  let result: BrowserEpisodeResult;
  try {
    result = await runBrowserEpisode(
      profile,
      root,
      optionInteger(options, "--seed") ?? 0,
      boundedDuration(optionNumber(options, "--duration-ms") ?? 30_000),
      async (frameFiles) => policy.predict(frameFiles),
      optionBoolean(options, "--viewable"),
      trace,
    );
  } finally {
    await policy.close();
  }
  return {
    command: "play",
    core: profile.core,
    profile: profile.id,
    score: result.score,
    realtime: result.realtime,
    trace: join(
      gameTrainingPaths(profile.core, root).tracesRoot,
      `${trace.metadata.sessionId}.jsonl`,
    ),
  };
}

async function playDesktopPolicy(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  if (!profile.supportedSurfaces.includes("desktop")) {
    throw new Error(`${profile.id} is not approved for desktop execution.`);
  }
  const artifactPath = resolve(requiredOption(options, "--artifact"));
  const artifact = await readGamePolicyArtifact(artifactPath);
  assertArtifactCompatible(
    artifact,
    profile.core,
    profile,
    gameTargetProfileDigest(profile),
    {
      actionCodec: actionCodecFor(profile.core),
      preprocessingVersion: preprocessingVersionFor(profile.core),
      frameSpec: frameSpecFor(profile.core),
    },
  );
  const isRemoteTarget = profile.targetOrigin?.kind === "remote";
  if (isRemoteTarget) await readRegisteredRemoteGameTarget(profile, root);
  const localTarget = isRemoteTarget
    ? undefined
    : await readRegisteredLocalGameTarget(profile, root);
  const windowTitle = requiredOption(options, "--window-title");
  const captureRegion = parseCaptureRegion(requiredOption(options, "--region"));
  const lease = await readDesktopLease(requiredOption(options, "--lease"));
  assertDesktopGameControlLease(lease, profile.id, windowTitle, captureRegion);
  const durationMs = boundedDuration(
    optionNumber(options, "--duration-ms") ?? 30_000,
  );
  const python =
    optionString(options, "--python") ??
    gameTrainingPython(gameTrainingPaths(profile.core, root).environmentRoot);
  const desktop = await runPythonDesktopWorker(python, {
    command: "desktop-doctor",
  });
  if (desktop.supported !== true) {
    throw new Error(desktop.detail ?? "Desktop game control is unavailable.");
  }
  const weightsFile = resolve(dirname(artifactPath), artifact.weightsFile);
  assertContainedPath(dirname(artifactPath), weightsFile);
  await assertGamePolicyWeights(artifact, weightsFile);
  const policy = await startPythonPolicySession(python, {
    core: profile.core,
    weightsFile,
    modelType: artifact.modelType,
  });
  const sessionId = randomUUID();
  const trace = {
    core: profile.core,
    profileId: profile.id,
    surface: "desktop" as const,
    sessionId,
  };
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "lhic-game-desktop-"),
  );
  const frameHistory: string[] = [];
  const activeKeys = new Set<string>();
  const history = frameSpecFor(profile.core).history;
  const server = localTarget
    ? await startLocalGameTargetServer(localTarget.sourceDirectory)
    : undefined;
  let startedAt = 0;
  let primaryDown = false;
  let batches = 0;
  let frameIndex = 0;
  const pacer = new GameFramePacer(profile.frameRate);

  await appendGameTrainingTrace(root, trace, "game_desktop_session_started", {
    captureWidth: captureRegion.width,
    captureHeight: captureRegion.height,
  });
  try {
    const browser = server
      ? await chromium.launch({ headless: false })
      : undefined;
    try {
      if (browser && server) {
        const context = await browser.newContext({
          viewport: profile.viewport,
        });
        await context.addInitScript(
          createSeededRandomInitScript(optionInteger(options, "--seed") ?? 0),
        );
        await restrictBrowserRequests(context, [new URL(server.url).origin]);
        const page = await context.newPage();
        await page.goto(server.url, { waitUntil: "domcontentloaded" });
        await startProfileIfPossible(page, profile);
        await page.bringToFront();
      } else {
        await appendGameTrainingTrace(
          root,
          trace,
          "game_desktop_existing_target_required",
        );
      }
      startedAt = performance.now();
      while (performance.now() - startedAt < durationMs) {
        const frameStartedAt = pacer.startFrame();
        assertDesktopGameControlLease(
          lease,
          profile.id,
          windowTitle,
          captureRegion,
        );
        await assertFocusedGameWindow(profile, windowTitle);
        const frameFile = join(
          temporaryDirectory,
          `frame-${frameIndex % history}.png`,
        );
        frameIndex += 1;
        await runPythonDesktopWorker(python, {
          command: "desktop-capture",
          captureRegion,
          frameFile,
        });
        frameHistory.push(frameFile);
        while (frameHistory.length > history) frameHistory.shift();
        while (frameHistory.length < history) frameHistory.unshift(frameFile);
        const action = await policy.predict([...frameHistory]);
        await assertFocusedGameWindow(profile, windowTitle);
        assertDesktopGameControlLease(
          lease,
          profile.id,
          windowTitle,
          captureRegion,
        );
        const desiredKeys = desktopDesiredKeys(profile, action);
        const pointer = desktopPointer(profile, action);
        const result = await runPythonDesktopWorker(python, {
          command: "desktop-apply",
          captureRegion,
          allowedKeys: profile.control.allowedKeys,
          activeKeys: [...activeKeys],
          desiredKeys,
          primaryDown,
          desiredPrimaryDown:
            profile.core !== "3d" &&
            profile.control.allowPrimaryClick &&
            action.fire,
          primaryClick:
            profile.core === "3d" &&
            profile.control.allowPrimaryClick &&
            action.fire,
          allowPrimaryClick: profile.control.allowPrimaryClick,
          aimMode: profile.control.aimMode,
          ...(pointer ? { pointer } : {}),
        });
        activeKeys.clear();
        for (const key of result.activeKeys ?? desiredKeys) activeKeys.add(key);
        primaryDown =
          result.primaryDown ??
          (profile.core !== "3d" &&
            profile.control.allowPrimaryClick &&
            action.fire);
        batches += 1;
        await appendGameTrainingTrace(
          root,
          trace,
          "game_desktop_control_batch",
          {
            batch: batches,
            observation: "captured",
            heldKeyCount: activeKeys.size,
            primaryDown,
          },
        );
        await pacer.completeFrame(frameStartedAt);
      }
    } finally {
      await browser?.close();
    }
  } catch (error) {
    await appendGameTrainingTrace(root, trace, "game_desktop_session_failed", {
      batches,
    }).catch(() => undefined);
    throw error;
  } finally {
    await runPythonDesktopWorker(python, {
      command: "desktop-release",
      allowedKeys: profile.control.allowedKeys,
      activeKeys: [...activeKeys],
    }).catch(() => undefined);
    await appendGameTrainingTrace(root, trace, "game_desktop_inputs_released", {
      batches,
    }).catch(() => undefined);
    await policy.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  const realtime = pacer.metrics();
  await appendGameTrainingTrace(root, trace, "game_desktop_session_completed", {
    controlBatches: batches,
    realtime,
  });
  return {
    command: "play",
    core: profile.core,
    profile: profile.id,
    surface: "desktop",
    controlBatches: batches,
    realtime,
    trace: join(
      gameTrainingPaths(profile.core, root).tracesRoot,
      `${sessionId}.jsonl`,
    ),
  };
}

async function runBrowserEpisode(
  profile: GameTargetProfile,
  root: string,
  seed: number,
  durationMs: number,
  nextAction: (frameFiles: string[]) => Promise<CoreGameAction>,
  viewable = false,
  trace?: GameExecutionTrace,
): Promise<BrowserEpisodeResult> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lhic-game-eval-"));
  const target = await openBrowserGameTarget(profile, root);
  const browser = await chromium.launch({ headless: !viewable });
  try {
    const context = await browser.newContext({ viewport: profile.viewport });
    if (target.supportsInjectedSeed) {
      await context.addInitScript(createSeededRandomInitScript(seed));
    }
    await restrictBrowserRequests(context, target.allowedOrigins);
    const page = await context.newPage();
    await page.goto(target.url, { waitUntil: "domcontentloaded" });
    await startProfileIfPossible(page, profile);
    if (trace) {
      await appendGameTrainingTrace(
        trace.root,
        trace.metadata,
        "game_browser_target_ready",
      );
      await appendGameTrainingTrace(
        trace.root,
        trace.metadata,
        "game_browser_session_started",
        {
          seed,
        },
      );
    }
    const activeKeys = new Set<string>();
    let primaryDown = false;
    const frameFiles: string[] = [];
    const history = frameSpecFor(profile.core).history;
    let frameIndex = 0;
    const pacer = new GameFramePacer(profile.frameRate);
    const startedAt = performance.now();
    try {
      while (performance.now() - startedAt < durationMs) {
        const frameStartedAt = pacer.startFrame();
        const frameFile = join(
          temporaryDirectory,
          `frame-${frameIndex % history}.png`,
        );
        frameIndex += 1;
        await page.screenshot({ path: frameFile });
        frameFiles.push(frameFile);
        while (frameFiles.length > history) frameFiles.shift();
        while (frameFiles.length < history) frameFiles.unshift(frameFile);
        const action = await nextAction([...frameFiles]);
        primaryDown = await applyBrowserAction(
          page,
          profile,
          action,
          activeKeys,
          primaryDown,
        );
        if (trace) {
          await appendGameTrainingTrace(
            trace.root,
            trace.metadata,
            "game_browser_control_batch",
            {
              heldKeyCount: activeKeys.size,
              primaryDown,
            },
          );
        }
        const telemetry = await readTelemetry(page, profile);
        if (telemetry.health !== undefined && telemetry.health <= 0) break;
        await pacer.completeFrame(frameStartedAt);
      }
    } finally {
      await releaseBrowserInputs(page, activeKeys, primaryDown);
      if (trace) {
        await appendGameTrainingTrace(
          trace.root,
          trace.metadata,
          "game_browser_inputs_released",
        );
      }
    }
    const result = {
      score: (await readTelemetry(page, profile)).score ?? 0,
      realtime: pacer.metrics(),
    };
    if (trace) {
      await appendGameTrainingTrace(
        trace.root,
        trace.metadata,
        "game_browser_session_completed",
        result,
      );
    }
    return result;
  } catch (error) {
    if (trace) {
      await appendGameTrainingTrace(
        trace.root,
        trace.metadata,
        "game_browser_session_failed",
      ).catch(() => undefined);
    }
    throw error;
  } finally {
    await browser.close();
    await target.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function openBrowserGameTarget(
  profile: GameTargetProfile,
  root: string,
): Promise<BrowserGameTarget> {
  if (profile.targetOrigin?.kind === "remote") {
    const target = await readRegisteredRemoteGameTarget(profile, root);
    return {
      url: target.url,
      allowedOrigins: target.allowedOrigins,
      supportsInjectedSeed: false,
      close: async () => undefined,
    };
  }
  const target = await readRegisteredLocalGameTarget(profile, root);
  const server = await startLocalGameTargetServer(target.sourceDirectory);
  return {
    url: server.url,
    allowedOrigins: [new URL(server.url).origin],
    supportsInjectedSeed: true,
    close: server.close,
  };
}

async function restrictBrowserRequests(
  context: BrowserContext,
  allowedOrigins: readonly string[],
): Promise<void> {
  const approvedOrigins = new Set(allowedOrigins);
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!approvedOrigins.has(requestUrl.origin)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function runScriptedBrowserDemonstration(
  page: Page,
  profile: GameTargetProfile,
  durationMs: number,
): Promise<void> {
  const activeKeys = new Set<string>();
  let primaryDown = false;
  const startedAt = performance.now();
  try {
    while (performance.now() - startedAt < durationMs) {
      const action = await scriptedActionFor(
        page,
        profile,
        performance.now() - startedAt,
      );
      primaryDown = await applyBrowserAction(
        page,
        profile,
        action,
        activeKeys,
        primaryDown,
      );
      await page.waitForTimeout(250);
    }
  } finally {
    await releaseBrowserInputs(page, activeKeys, primaryDown);
  }
}

async function scriptedActionFor(
  page: Page,
  profile: GameTargetProfile,
  elapsedMs: number,
): Promise<CoreGameAction> {
  if (profile.core === "2d") {
    const tracking = await page
      .evaluate(() => {
        const game = (
          window as typeof window & {
            game?: {
              scene?: {
                keys?: Record<
                  string,
                  {
                    player?: { x?: number; y?: number };
                    enemies?: {
                      getChildren?: () => Array<{ x?: number; y?: number }>;
                    };
                  }
                >;
              };
            };
          }
        ).game;
        const scene = game?.scene?.keys?.SceneMain;
        const player = scene?.player;
        const enemies = scene?.enemies?.getChildren?.() ?? [];
        const playerX = player?.x;
        const playerY = player?.y;
        if (typeof playerX !== "number" || typeof playerY !== "number") {
          return undefined;
        }
        let targetX: number | undefined;
        let distance = Number.POSITIVE_INFINITY;
        for (const enemy of enemies) {
          if (
            typeof enemy.x !== "number" ||
            typeof enemy.y !== "number" ||
            enemy.y >= playerY
          ) {
            continue;
          }
          const candidateDistance = Math.abs(enemy.x - playerX);
          if (candidateDistance < distance) {
            targetX = enemy.x;
            distance = candidateDistance;
          }
        }
        return targetX === undefined ? undefined : { playerX, targetX };
      })
      .catch(() => undefined);
    if (tracking) {
      const movement =
        tracking.targetX < tracking.playerX - 6
          ? ["KeyA"]
          : tracking.targetX > tracking.playerX + 6
            ? ["KeyD"]
            : [];
      return { movement, fire: true };
    }
    const phase = Math.floor(elapsedMs / 900) % 4;
    const movement = phase < 2 ? ["KeyA"] : ["KeyD"];
    return { movement, fire: true };
  }
  if (profile.id === "epic-shooter-3d") {
    const phase = Math.floor(elapsedMs / 750) % 8;
    const movement = [
      ["KeyW"],
      ["KeyA"],
      ["KeyS"],
      ["KeyD"],
      ["KeyW", "KeyA"],
      ["KeyW", "KeyD"],
      ["KeyS", "KeyA"],
      ["KeyS", "KeyD"],
    ][phase]!;
    const lookDelta = [48, 16, -16, -48, -16, 16, 32, -32][phase]!;
    return {
      movement,
      fire: true,
      look: { deltaX: lookDelta, deltaY: 0 },
    };
  }
  const target = await page
    .evaluate(() => {
      const runtime = window as typeof window & {
        ai?: Array<{
          position?: {
            distanceTo?: (position: unknown) => number;
            clone?: () => unknown;
          };
        }>;
        cam?: { position?: unknown };
        projector?: {
          projectVector?: (
            vector: unknown,
            camera: unknown,
          ) => { x?: number; y?: number };
        };
      };
      const camera = runtime.cam;
      const projector = runtime.projector;
      if (!camera || !projector?.projectVector || !Array.isArray(runtime.ai)) {
        return undefined;
      }
      const closest = runtime.ai
        .filter(
          (candidate) =>
            candidate.position?.clone && candidate.position.distanceTo,
        )
        .sort(
          (left, right) =>
            (left.position?.distanceTo?.(camera.position) ??
              Number.POSITIVE_INFINITY) -
            (right.position?.distanceTo?.(camera.position) ??
              Number.POSITIVE_INFINITY),
        )[0];
      const position = closest?.position?.clone?.();
      if (!position) return undefined;
      const projected = projector.projectVector(position, camera);
      if (typeof projected.x !== "number" || typeof projected.y !== "number") {
        return undefined;
      }
      return { x: projected.x, y: projected.y };
    })
    .catch(() => undefined);
  const movement =
    target?.x === undefined
      ? elapsedMs % 1_500 < 750
        ? ["KeyW", "KeyA"]
        : ["KeyW", "KeyD"]
      : target.x < -0.08
        ? ["KeyA"]
        : target.x > 0.08
          ? ["KeyD"]
          : ["KeyW"];
  return {
    movement,
    fire: true,
    look: {
      deltaX: target ? clampPointerDelta(target.x * 48) : 16,
      deltaY: target ? clampPointerDelta(-target.y * 48) : 0,
    },
  };
}

function clampPointerDelta(value: number): number {
  return boundedRelativeLook(value, 48);
}

function boundedRelativeLook(
  value: number,
  maximum: number | undefined,
): number {
  if (!maximum || maximum < 1) {
    throw new Error("Relative-look profiles require a positive pointer bound.");
  }
  const bounded = Math.max(-maximum, Math.min(maximum, value));
  const step = Math.max(1, Math.round(maximum / 3));
  return Math.round(bounded / step) * step;
}

async function collectBrowserSamples(
  page: Page,
  profile: GameTargetProfile,
  framesDirectory: string,
  durationMs: number,
): Promise<BrowserRecording> {
  const samples: GameDatasetManifest["samples"] = [];
  const pacer = new GameFramePacer(profile.frameRate);
  const startedAt = performance.now();
  while (performance.now() - startedAt < durationMs) {
    const frameStartedAt = pacer.startFrame();
    const index = String(samples.length).padStart(6, "0");
    const frameName = `${index}.png`;
    await page.screenshot({ path: join(framesDirectory, frameName) });
    const input = await readRecordedInput(page, profile);
    const telemetry = await readTelemetry(page, profile);
    const terminal = telemetry.health !== undefined && telemetry.health <= 0;
    samples.push(
      createGameEpisodeSample({
        timestampMs: Math.round(performance.now() - startedAt),
        frame: join("frames", frameName),
        input,
        telemetry: { ...telemetry, terminal },
      }),
    );
    if (terminal) break;
    await pacer.completeFrame(frameStartedAt);
  }
  return { samples, realtime: pacer.metrics() };
}

async function applyBrowserAction(
  page: Page,
  profile: GameTargetProfile,
  action: CoreGameAction,
  activeKeys: Set<string>,
  primaryDown: boolean,
): Promise<boolean> {
  const desiredKeys = new Set(action.movement);
  if (profile.core === "2d" && action.fire) desiredKeys.add("Space");
  for (const key of activeKeys) {
    if (!desiredKeys.has(key)) {
      await page.keyboard.up(key);
      activeKeys.delete(key);
    }
  }
  for (const key of desiredKeys) {
    if (!activeKeys.has(key)) {
      await page.keyboard.down(key);
      activeKeys.add(key);
    }
  }
  if (action.look) {
    const x = profile.viewport.width / 2 + action.look.deltaX;
    const y = profile.viewport.height / 2 + action.look.deltaY;
    await page.mouse.move(x, y);
  }
  if (action.aim) {
    await page.mouse.move(
      action.aim.x * profile.viewport.width,
      action.aim.y * profile.viewport.height,
    );
  }
  if (profile.core === "3d" && action.fire) {
    if (primaryDown) await page.mouse.up();
    await page.mouse.click(
      action.look
        ? profile.viewport.width / 2 + action.look.deltaX
        : profile.viewport.width / 2,
      action.look
        ? profile.viewport.height / 2 + action.look.deltaY
        : profile.viewport.height / 2,
    );
    return false;
  }
  if (profile.control.allowPrimaryClick && action.fire !== primaryDown) {
    if (action.fire) await page.mouse.down();
    else await page.mouse.up();
    return action.fire;
  }
  return primaryDown;
}

async function releaseBrowserInputs(
  page: Page,
  activeKeys: Set<string>,
  primaryDown: boolean,
): Promise<void> {
  await Promise.all(
    [...activeKeys].map((key) => page.keyboard.up(key).catch(() => undefined)),
  );
  if (primaryDown) await page.mouse.up().catch(() => undefined);
}

async function readTelemetry(
  page: Page,
  profile: GameTargetProfile,
): Promise<{ score?: number; health?: number }> {
  const read = async (
    selector: string | undefined,
  ): Promise<number | undefined> => {
    if (!selector) return undefined;
    const text = await page
      .locator(selector)
      .first()
      .textContent()
      .catch(() => null);
    if (!text) return undefined;
    const value = Number(text.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(value) ? value : undefined;
  };
  const readStorage = async (
    key: string | undefined,
  ): Promise<number | undefined> => {
    if (!key) return undefined;
    return page
      .evaluate((storageKey) => {
        const value = window.localStorage.getItem(storageKey);
        if (value === null) return undefined;
        try {
          const parsed = JSON.parse(value) as unknown;
          const number = typeof parsed === "number" ? parsed : Number(parsed);
          return Number.isFinite(number) ? number : undefined;
        } catch {
          const number = Number(value);
          return Number.isFinite(number) ? number : undefined;
        }
      }, key)
      .catch(() => undefined);
  };
  const [selectorScore, selectorHealth, storageScore, storageHealth] =
    await Promise.all([
      read(profile.telemetry.scoreSelector),
      read(profile.telemetry.healthSelector),
      readStorage(profile.telemetry.scoreStorageKey),
      readStorage(profile.telemetry.healthStorageKey),
    ]);
  const score = storageScore ?? selectorScore;
  const health = storageHealth ?? selectorHealth;
  return {
    ...(score === undefined ? {} : { score }),
    ...(health === undefined ? {} : { health }),
  };
}

async function startProfileIfPossible(
  page: Page,
  profile: GameTargetProfile,
): Promise<void> {
  const selectors = [
    ...(profile.telemetry.startSelectors ?? []),
    ...(profile.telemetry.startSelector
      ? [profile.telemetry.startSelector]
      : []),
  ];
  const strictStartup = Boolean(profile.telemetry.readySelector);
  const attempts = strictStartup ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const alreadyReady = profile.telemetry.readySelector
        ? await page
            .locator(profile.telemetry.readySelector)
            .first()
            .isVisible()
            .catch(() => false)
        : false;
      if (!alreadyReady) {
        if (profile.startInput) {
          await page
            .locator(profile.startInput.selector)
            .fill(profile.startInput.value, { timeout: 5_000 });
        }
        for (const selector of selectors) {
          const click = page
            .locator(selector)
            .first()
            .click({ timeout: 5_000 });
          if (strictStartup) await click;
          else await click.catch(() => undefined);
        }
      }
      if (profile.telemetry.readySelector) {
        await page.locator(profile.telemetry.readySelector).first().waitFor({
          state: "visible",
          timeout: 5_000,
        });
      }
      await assertPointerLockIfRequired(page, profile);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await page.waitForTimeout(500);
    }
  }
  if (strictStartup) {
    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new Error(
      `Game target did not become ready after startup retries${detail}`,
    );
  }
}

async function assertPointerLockIfRequired(
  page: Page,
  profile: GameTargetProfile,
): Promise<void> {
  if (!profile.requiresPointerLock) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const locked = await page.evaluate(
      () => document.pointerLockElement !== null,
    );
    if (locked) return;
    await page.mouse.click(
      profile.viewport.width / 2,
      profile.viewport.height / 2,
    );
    await page.waitForTimeout(250);
  }
  throw new Error(
    "Game target requires browser pointer lock; use an interactive desktop session that permits pointer lock.",
  );
}

async function readRecordedInput(
  page: Page,
  profile: GameTargetProfile,
): Promise<GameInputSample> {
  const value = await page.evaluate(
    (allowedKeys) => {
      const readInput = (
        window as typeof window & {
          __lhicReadGameInput?: () => {
            keys: string[];
            primaryDown: boolean;
            x: number;
            y: number;
            deltaX: number;
            deltaY: number;
          };
        }
      ).__lhicReadGameInput;
      if (!readInput) throw new Error("Game input recorder is unavailable.");
      const recorder = readInput();
      return {
        keys: recorder.keys.filter((key) => allowedKeys.includes(key)),
        primaryDown: recorder.primaryDown,
        x: recorder.x / Math.max(window.innerWidth, 1),
        y: recorder.y / Math.max(window.innerHeight, 1),
        deltaX: recorder.deltaX,
        deltaY: recorder.deltaY,
      };
    },
    [...profile.control.allowedKeys],
  );
  return {
    timestampMs: Math.round(performance.now()),
    heldKeys: value.keys,
    primaryDown: value.primaryDown,
    ...(profile.control.aimMode === "absolute"
      ? { pointerX: value.x, pointerY: value.y }
      : {}),
    ...(profile.control.aimMode === "relative"
      ? {
          pointerDeltaX: boundedRelativeLook(
            value.deltaX,
            profile.control.maxPointerDelta,
          ),
          pointerDeltaY: boundedRelativeLook(
            value.deltaY,
            profile.control.maxPointerDelta,
          ),
        }
      : {}),
  };
}

function desktopRecordedInput(
  profile: GameTargetProfile,
  input: PythonDesktopInput,
): GameInputSample {
  if (
    input.heldKeys.some((key) => !profile.control.allowedKeys.includes(key))
  ) {
    throw new Error(
      "Desktop recorder returned a key outside the control profile.",
    );
  }
  const pointerX = finiteInputNumber(input.pointerX);
  const pointerY = finiteInputNumber(input.pointerY);
  const pointerDeltaX = finiteInputNumber(input.pointerDeltaX);
  const pointerDeltaY = finiteInputNumber(input.pointerDeltaY);
  return {
    timestampMs: Math.round(performance.now()),
    heldKeys: input.heldKeys,
    primaryDown: input.primaryDown,
    ...(profile.control.aimMode === "absolute"
      ? {
          pointerX: Math.max(0, Math.min(1, pointerX)),
          pointerY: Math.max(0, Math.min(1, pointerY)),
        }
      : {}),
    ...(profile.control.aimMode === "relative"
      ? {
          pointerDeltaX: boundedRelativeLook(
            pointerDeltaX,
            profile.control.maxPointerDelta,
          ),
          pointerDeltaY: boundedRelativeLook(
            pointerDeltaY,
            profile.control.maxPointerDelta,
          ),
        }
      : {}),
  };
}

function finiteInputNumber(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) {
    throw new Error("Desktop recorder returned a non-finite pointer value.");
  }
  return value;
}

function installInputRecorder(): void {
  const state = {
    keys: new Set<string>(),
    primaryDown: false,
    firedSinceLastRead: false,
    x: 0,
    y: 0,
    deltaX: 0,
    deltaY: 0,
  };
  (
    window as typeof window & { __lhicReadGameInput?: () => unknown }
  ).__lhicReadGameInput = () => {
    const result = {
      keys: [...state.keys],
      primaryDown: state.primaryDown || state.firedSinceLastRead,
      x: state.x,
      y: state.y,
      deltaX: state.deltaX,
      deltaY: state.deltaY,
    };
    state.deltaX = 0;
    state.deltaY = 0;
    state.firedSinceLastRead = false;
    return result;
  };
  window.addEventListener("keydown", (event) => {
    state.keys.add(event.code);
  });
  window.addEventListener("keyup", (event) => {
    state.keys.delete(event.code);
  });
  window.addEventListener("mousedown", (event) => {
    if (event.button === 0) {
      state.primaryDown = true;
      state.firedSinceLastRead = true;
    }
  });
  window.addEventListener("mouseup", (event) => {
    if (event.button === 0) state.primaryDown = false;
  });
  window.addEventListener("mousemove", (event) => {
    state.x = event.clientX;
    state.y = event.clientY;
    state.deltaX += event.movementX;
    state.deltaY += event.movementY;
  });
}

function frameSpecFor(core: GameCoreId) {
  return core === "2d" ? game2dFrameSpec : game3dFrameSpec;
}

function actionCodecFor(core: GameCoreId): string {
  return core === "2d" ? game2dActionCodec : game3dActionCodec;
}

function preprocessingVersionFor(core: GameCoreId): string {
  return core === "2d"
    ? game2dPreprocessingVersion
    : game3dPreprocessingVersion;
}

function supportsInjectedSeed(profile: GameTargetProfile): boolean {
  return profile.targetOrigin?.supportsInjectedSeed ?? true;
}

function randomActionFor(
  profile: GameTargetProfile,
  random: () => number,
): CoreGameAction {
  return profile.core === "2d"
    ? randomGame2dAction(random, profile)
    : randomGame3dAction(random, profile);
}

function gameTrainingPython(environmentRoot: string): string {
  return process.platform === "win32"
    ? join(environmentRoot, "Scripts", "python.exe")
    : join(environmentRoot, "bin", "python");
}

function parseOptions(argumentsList: string[]): Map<string, string | true> {
  const options = new Map<string, string | true>();
  for (let index = 0; index < argumentsList.length; index += 1) {
    const option = argumentsList[index]!;
    if (!option.startsWith("--"))
      throw new Error(`Unknown game-training argument: ${option}.`);
    const next = argumentsList[index + 1];
    if (next && !next.startsWith("--")) {
      options.set(option, next);
      index += 1;
    } else {
      options.set(option, true);
    }
  }
  return options;
}

function requiredOption(
  options: Map<string, string | true>,
  name: string,
): string {
  const value = options.get(name);
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required.`);
  return value;
}

function optionString(
  options: Map<string, string | true>,
  name: string,
): string | undefined {
  const value = options.get(name);
  return typeof value === "string" ? value : undefined;
}

function optionNumber(
  options: Map<string, string | true>,
  name: string,
): number | undefined {
  const value = optionString(options, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

function optionInteger(
  options: Map<string, string | true>,
  name: string,
): number | undefined {
  const value = optionNumber(options, name);
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value))
    throw new Error(`${name} must be a safe integer.`);
  return value;
}

function optionBoolean(
  options: Map<string, string | true>,
  name: string,
): boolean {
  return options.get(name) === true;
}

function selectedSurface(
  options: Map<string, string | true>,
): "browser" | "desktop" {
  const surface = optionString(options, "--surface") ?? "browser";
  if (surface === "browser" || surface === "desktop") return surface;
  throw new Error("--surface must be browser or desktop.");
}

function assertBrowserSurface(options: Map<string, string | true>): void {
  if (selectedSurface(options) !== "browser") {
    throw new Error(
      "Desktop sessions require a verified GameControlLease and the Python desktop driver; use `--surface browser` for the direct browser runner.",
    );
  }
}

function parseCaptureRegion(value: string): GameCaptureRegion {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isSafeInteger(part)) ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[3] === undefined ||
    parts[0] < 0 ||
    parts[1] < 0 ||
    parts[2] < 1 ||
    parts[3] < 1
  ) {
    throw new Error(
      "--region must be x,y,width,height using non-negative integers.",
    );
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

async function readDesktopLease(filePath: string): Promise<GameControlLease> {
  try {
    return JSON.parse(
      await readFile(resolve(filePath), "utf8"),
    ) as GameControlLease;
  } catch {
    throw new Error("Desktop game-control lease could not be read.");
  }
}

async function assertFocusedGameWindow(
  profile: GameTargetProfile,
  windowTitle: string,
): Promise<void> {
  const state = await inspectActiveGlobalDesktop(
    new ExecFileGlobalCommandRunner(),
    getGlobalDesktopPlatform(),
  );
  if (!matchesFocusedGameWindowTitle(profile.id, windowTitle, state.title)) {
    throw new Error("The approved game window is no longer focused.");
  }
}

export function matchesFocusedGameWindowTitle(
  profileId: string,
  windowTitle: string,
  activeWindowTitle: string | undefined,
): boolean {
  const expected = windowTitle.trim();
  const active = activeWindowTitle?.trim();
  if (!active) return false;
  if (active === expected) return true;

  return (
    profileId === "epic-shooter-3d" &&
    expected === "Epic Shooter 3D - Google Chrome" &&
    /^Epic Shooter 3D(?: - .+)? - Google Chrome$/.test(active)
  );
}

function desktopDesiredKeys(
  profile: GameTargetProfile,
  action: CoreGameAction,
): string[] {
  if (
    action.movement.some((key) => !profile.control.allowedKeys.includes(key))
  ) {
    throw new Error(
      "Model action includes a key outside the approved control profile.",
    );
  }
  const desired = new Set(action.movement);
  if (profile.core === "2d" && action.fire) desired.add("Space");
  if ([...desired].some((key) => !profile.control.allowedKeys.includes(key))) {
    throw new Error(
      "Model action includes a key outside the approved control profile.",
    );
  }
  return [...desired];
}

function desktopPointer(
  profile: GameTargetProfile,
  action: CoreGameAction,
):
  | { mode: "relative"; deltaX: number; deltaY: number; maximum: number }
  | { mode: "absolute"; x: number; y: number }
  | undefined {
  if (profile.control.aimMode === "relative") {
    if (!action.look || !profile.control.maxPointerDelta) {
      throw new Error(
        "Relative-look profile received an incompatible model action.",
      );
    }
    return {
      mode: "relative",
      deltaX: action.look.deltaX,
      deltaY: action.look.deltaY,
      maximum: profile.control.maxPointerDelta,
    };
  }
  if (profile.control.aimMode === "absolute") {
    if (!action.aim)
      throw new Error(
        "Absolute-aim profile received an incompatible model action.",
      );
    return { mode: "absolute", x: action.aim.x, y: action.aim.y };
  }
  return undefined;
}

function boundedDuration(value: number): number {
  if (!Number.isFinite(value) || value < 1_000 || value > 5 * 60_000) {
    throw new Error("--duration-ms must be between 1000 and 300000.");
  }
  return Math.round(value);
}

function boundedEpisodes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
    throw new Error("--episodes must be an integer between 1 and 10.");
  }
  return value;
}

function summarizeDatasetQuality(
  profile: GameTargetProfile,
  samples: readonly GameDatasetManifest["samples"][number][],
): GameDatasetQuality {
  const durationMs = samples.at(-1)?.timestampMs ?? 0;
  const movementActions = new Set(
    samples.map((sample) => [...sample.input.heldKeys].sort().join(",")),
  );
  const fireSampleCount = samples.filter(
    (sample) => sample.input.primaryDown,
  ).length;
  const lookSampleCount = samples.filter((sample) => {
    if (profile.control.aimMode === "relative") {
      return (
        sample.input.pointerDeltaX !== 0 || sample.input.pointerDeltaY !== 0
      );
    }
    if (profile.control.aimMode === "absolute") {
      return (
        sample.input.pointerX !== undefined ||
        sample.input.pointerY !== undefined
      );
    }
    return false;
  }).length;
  return {
    sampleCount: samples.length,
    durationMs,
    captureRateHz:
      durationMs > 0
        ? Number(((samples.length * 1_000) / durationMs).toFixed(3))
        : 0,
    movementActionCount: movementActions.size,
    fireSampleCount,
    lookSampleCount,
  };
}

function assertDatasetTrainable(
  profile: GameTargetProfile,
  quality: GameDatasetQuality,
): void {
  if (quality.sampleCount < 16) {
    throw new Error(
      "Game-policy fitting requires at least 16 recorded samples.",
    );
  }
  if (quality.movementActionCount < 2) {
    throw new Error(
      "Game-policy fitting requires demonstrations of at least two movement actions.",
    );
  }
  if (profile.control.allowPrimaryClick && quality.fireSampleCount === 0) {
    throw new Error(
      "Game-policy fitting requires at least one approved primary-fire sample.",
    );
  }
  if (profile.control.aimMode === "relative" && quality.lookSampleCount === 0) {
    throw new Error(
      "Game-policy fitting requires at least one bounded relative-look sample.",
    );
  }
}

function assertContainedPath(directory: string, candidate: string): void {
  if (relative(resolve(directory), resolve(candidate)).startsWith("..")) {
    throw new Error(
      "Game-policy weights must be stored beside their artifact manifest.",
    );
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanOrZero(values: readonly number[]): number {
  return values.length === 0 ? 0 : mean(values);
}

function errorDetail(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.slice(0, 500);
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createDesktopGameControlLease(
  profileId: string,
  windowTitle: string,
  captureRegion: { x: number; y: number; width: number; height: number },
  approvedBy: string,
): GameControlLease {
  const profile = getGameTargetProfile(profileId);
  return createGameControlLease(
    {
      core: profile.core,
      profileId: profile.id,
      windowTitle,
      captureRegion,
      control: profile.control,
    },
    approvedBy,
  );
}

export function assertDesktopGameControlLease(
  lease: GameControlLease | undefined,
  profileId: string,
  windowTitle: string,
  captureRegion: { x: number; y: number; width: number; height: number },
): void {
  const profile = getGameTargetProfile(profileId);
  const result = validateGameControlLease(lease, {
    core: profile.core,
    profileId: profile.id,
    windowTitle,
    captureRegion,
    control: profile.control,
  });
  if (!result.valid) throw new Error(result.reason);
}
