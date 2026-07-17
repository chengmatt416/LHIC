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
  gameTargetProfileDigest,
  gameTrainingPaths,
  getGameTargetProfile,
  readGamePolicyArtifact,
  readRegisteredLocalGameTarget,
  registerLocalGameTarget,
  runPythonPrediction,
  runPythonDesktopWorker,
  runPythonTraining,
  inspectGameTrainingEnvironment,
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
  type GameTargetProfile,
  type GameTraceMetadata,
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
import { chromium, type Page } from "playwright";
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
      return recordBrowserDataset(profile, parsed, root);
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
  const target = await readRegisteredLocalGameTarget(profile, root);
  const server = await startLocalGameTargetServer(target.sourceDirectory);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: profile.viewport });
    await context.addInitScript(createSeededRandomInitScript(seed));
    await context.addInitScript(installInputRecorder);
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== new URL(server.url).origin) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await startProfileIfPossible(page, profile);
    const samples = await collectBrowserSamples(
      page,
      profile,
      framesDirectory,
      durationMs,
    );
    const manifest: GameDatasetManifest = {
      schemaVersion: "game-dataset-v1",
      core: profile.core,
      profileId: profile.id,
      profileDigest: gameTargetProfileDigest(profile),
      preprocessingVersion: preprocessingVersionFor(profile.core),
      actionCodec: actionCodecFor(profile.core),
      seed,
      surface: "browser",
      createdAt: new Date().toISOString(),
      samples,
    };
    const manifestPath = join(output, "manifest.json");
    await writeGameDatasetManifest(manifestPath, manifest);
    return {
      command: "record",
      core: profile.core,
      profile: profile.id,
      dataset: manifestPath,
      sampleCount: samples.length,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}

async function fitPolicy(
  profile: GameTargetProfile,
  options: Map<string, string | true>,
  root: string,
): Promise<GameTrainingReport> {
  const datasetPath = resolve(requiredOption(options, "--dataset"));
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
    metrics: {
      behaviorCloningLoss: result.behaviorCloningLoss,
      ppoReward: result.ppoReward,
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
  const target = await readRegisteredLocalGameTarget(profile, root);
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
    learnedScores.push(
      await runBrowserEpisode(
        profile,
        target.sourceDirectory,
        seed,
        durationMs,
        async (frameFiles) =>
          runPythonPrediction(python, {
            core: profile.core,
            weightsFile,
            frameFiles,
          }),
        false,
        learnedTrace,
      ),
    );
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
    randomScores.push(
      await runBrowserEpisode(
        profile,
        target.sourceDirectory,
        seed,
        durationMs,
        async () => randomActionFor(profile, random),
        false,
        randomTrace,
      ),
    );
  }
  const learnedMeanScore = mean(learnedScores);
  const randomMeanScore = mean(randomScores);
  const report = {
    command: "evaluate",
    core: profile.core,
    profile: profile.id,
    episodes,
    learnedScores,
    randomScores,
    learnedMeanScore,
    randomMeanScore,
    passed: learnedMeanScore > 0 && learnedMeanScore > randomMeanScore,
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
  const target = await readRegisteredLocalGameTarget(profile, root);
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
  const score = await runBrowserEpisode(
    profile,
    target.sourceDirectory,
    optionInteger(options, "--seed") ?? 0,
    boundedDuration(optionNumber(options, "--duration-ms") ?? 30_000),
    async (frameFiles) =>
      runPythonPrediction(python, {
        core: profile.core,
        weightsFile,
        frameFiles,
      }),
    optionBoolean(options, "--viewable"),
    trace,
  );
  return {
    command: "play",
    core: profile.core,
    profile: profile.id,
    score,
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
  const target = await readRegisteredLocalGameTarget(profile, root);
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
  const server = await startLocalGameTargetServer(target.sourceDirectory);
  let startedAt = 0;
  let primaryDown = false;
  let batches = 0;
  let frameIndex = 0;

  await appendGameTrainingTrace(root, trace, "game_desktop_session_started", {
    captureWidth: captureRegion.width,
    captureHeight: captureRegion.height,
  });
  try {
    const browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext({ viewport: profile.viewport });
      await context.addInitScript(
        createSeededRandomInitScript(optionInteger(options, "--seed") ?? 0),
      );
      await context.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin !== new URL(server.url).origin) {
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      const page = await context.newPage();
      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await startProfileIfPossible(page, profile);
      await page.bringToFront();
      startedAt = performance.now();
      while (performance.now() - startedAt < durationMs) {
        assertDesktopGameControlLease(
          lease,
          profile.id,
          windowTitle,
          captureRegion,
        );
        await assertFocusedGameWindow(windowTitle);
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
        const action = await runPythonPrediction(python, {
          core: profile.core,
          weightsFile,
          frameFiles: [...frameHistory],
        });
        await assertFocusedGameWindow(windowTitle);
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
          desiredPrimaryDown: profile.control.allowPrimaryClick && action.fire,
          allowPrimaryClick: profile.control.allowPrimaryClick,
          aimMode: profile.control.aimMode,
          ...(pointer ? { pointer } : {}),
        });
        activeKeys.clear();
        for (const key of result.activeKeys ?? desiredKeys) activeKeys.add(key);
        primaryDown =
          result.primaryDown ??
          (profile.control.allowPrimaryClick && action.fire);
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
        await waitForFrame(profile.frameRate);
      }
    } finally {
      await browser.close();
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
    await server.close().catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  return {
    command: "play",
    core: profile.core,
    profile: profile.id,
    surface: "desktop",
    controlBatches: batches,
    trace: join(
      gameTrainingPaths(profile.core, root).tracesRoot,
      `${sessionId}.jsonl`,
    ),
  };
}

async function runBrowserEpisode(
  profile: GameTargetProfile,
  sourceDirectory: string,
  seed: number,
  durationMs: number,
  nextAction: (frameFiles: string[]) => Promise<CoreGameAction>,
  viewable = false,
  trace?: GameExecutionTrace,
): Promise<number> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lhic-game-eval-"));
  const server = await startLocalGameTargetServer(sourceDirectory);
  const browser = await chromium.launch({ headless: !viewable });
  try {
    const context = await browser.newContext({ viewport: profile.viewport });
    await context.addInitScript(createSeededRandomInitScript(seed));
    await context.route("**/*", async (route) => {
      const requestUrl = new URL(route.request().url());
      if (requestUrl.origin !== new URL(server.url).origin) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await startProfileIfPossible(page, profile);
    if (trace) {
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
    const startedAt = performance.now();
    try {
      while (performance.now() - startedAt < durationMs) {
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
        await page.waitForTimeout(Math.round(1_000 / profile.frameRate));
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
    return (await readTelemetry(page, profile)).score ?? 0;
  } finally {
    await browser.close();
    await server.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function collectBrowserSamples(
  page: Page,
  profile: GameTargetProfile,
  framesDirectory: string,
  durationMs: number,
): Promise<GameDatasetManifest["samples"]> {
  const samples: GameDatasetManifest["samples"] = [];
  const startedAt = performance.now();
  while (performance.now() - startedAt < durationMs) {
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
    await page.waitForTimeout(Math.round(1_000 / profile.frameRate));
  }
  return samples;
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
    ...(profile.telemetry.startSelector ? [profile.telemetry.startSelector] : []),
  ];
  for (const selector of selectors) {
    await page
      .locator(selector)
      .first()
      .click({ timeout: 1_000 })
      .catch(() => undefined);
  }
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
      ? { pointerDeltaX: value.deltaX, pointerDeltaY: value.deltaY }
      : {}),
  };
}

function installInputRecorder(): void {
  const state = {
    keys: new Set<string>(),
    primaryDown: false,
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
      primaryDown: state.primaryDown,
      x: state.x,
      y: state.y,
      deltaX: state.deltaX,
      deltaY: state.deltaY,
    };
    state.deltaX = 0;
    state.deltaY = 0;
    return result;
  };
  window.addEventListener("keydown", (event) => {
    state.keys.add(event.code);
  });
  window.addEventListener("keyup", (event) => {
    state.keys.delete(event.code);
  });
  window.addEventListener("mousedown", (event) => {
    if (event.button === 0) state.primaryDown = true;
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

async function assertFocusedGameWindow(windowTitle: string): Promise<void> {
  const state = await inspectActiveGlobalDesktop(
    new ExecFileGlobalCommandRunner(),
    getGlobalDesktopPlatform(),
  );
  if (state.title?.trim() !== windowTitle.trim()) {
    throw new Error("The approved game window is no longer focused.");
  }
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

function waitForFrame(frameRate: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, Math.round(1_000 / frameRate));
  });
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
