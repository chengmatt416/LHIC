import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createGameControlLease,
  validateGameControlLease,
  type GameControlLease,
} from "./lease.js";
import {
  createGameEpisodeSample,
  writeGameDatasetManifest,
} from "./dataset.js";
import { GameFramePacer, type GameRealtimeMetrics } from "./frame-pacer.js";
import { gameTrainingPaths } from "./paths.js";
import { gameTargetProfileDigest } from "./profiles.js";
import {
  gameTrainingPythonPath,
  startPythonDesktopRecordingSession,
  type PythonDesktopInput,
  type PythonDesktopRecordingSession,
} from "./python-worker.js";
import { appendGameTrainingTrace } from "./trace.js";
import type {
  GameCaptureRegion,
  GameDatasetManifest,
  GameInputSample,
  GameTraceMetadata,
  GameTargetProfile,
} from "./types.js";

export interface DesktopHumanRecordingRequest {
  profile: GameTargetProfile;
  root: string;
  windowTitle: string;
  captureRegion: GameCaptureRegion;
  approvedBy: string;
  durationMs: number;
  actionCodec: string;
  preprocessingVersion: string;
  python?: string;
  signal?: AbortSignal;
  assertFocused(): Promise<void>;
  createRecorder?: (
    python: string,
    request: {
      allowedKeys: string[];
      captureRegion: GameCaptureRegion;
    },
  ) => Promise<PythonDesktopRecordingSession>;
}

export interface DesktopHumanRecordingReport {
  datasetPath: string;
  tracePath: string;
  sampleCount: number;
  lease: Pick<GameControlLease, "leaseId" | "expiresAt" | "requestHash">;
  realtime: GameRealtimeMetrics;
}

/**
 * Records a human-operated desktop game locally. This routine never injects
 * input and never sends frames or input samples to a model or network service.
 */
export async function recordDesktopHumanPlay(
  request: DesktopHumanRecordingRequest,
): Promise<DesktopHumanRecordingReport> {
  assertRequest(request);
  const root = resolve(request.root);
  const paths = gameTrainingPaths(request.profile.core, root);
  const output = join(
    paths.datasetsRoot,
    `${safePathSegment(request.profile.id)}-${Date.now()}-${randomUUID()}`,
  );
  const framesDirectory = join(output, "frames");
  const trace: GameTraceMetadata = {
    core: request.profile.core,
    profileId: request.profile.id,
    surface: "desktop",
    sessionId: randomUUID(),
  };
  const lease = createGameControlLease(
    {
      core: request.profile.core,
      profileId: request.profile.id,
      windowTitle: request.windowTitle,
      captureRegion: request.captureRegion,
      control: request.profile.control,
    },
    request.approvedBy,
  );
  const python =
    request.python ?? gameTrainingPythonPath(paths.environmentRoot);
  const createRecorder =
    request.createRecorder ?? startPythonDesktopRecordingSession;

  await mkdir(framesDirectory, { recursive: true });
  const recorder = await createRecorder(python, {
    allowedKeys: [...request.profile.control.allowedKeys],
    captureRegion: request.captureRegion,
  });
  const samples: GameDatasetManifest["samples"] = [];
  const pacer = new GameFramePacer(request.profile.frameRate);
  const startedAt = performance.now();

  try {
    await appendGameTrainingTrace(root, trace, "game_human_recording_started", {
      durationMs: request.durationMs,
      captureRegion: request.captureRegion,
      leaseId: lease.leaseId,
    });
    while (performance.now() - startedAt < request.durationMs) {
      assertNotAborted(request.signal);
      assertLease(lease, request);
      await request.assertFocused();
      const frameStartedAt = pacer.startFrame();
      const index = String(samples.length).padStart(6, "0");
      const frame = `frames/${index}.png`;
      await recorder.capture(join(output, frame));
      const input = await recorder.readInput();
      assertNotAborted(request.signal);
      assertLease(lease, request);
      await request.assertFocused();
      samples.push(
        createGameEpisodeSample({
          timestampMs: Math.round(performance.now() - startedAt),
          frame,
          input: sanitizeDesktopInput(request.profile, input),
          telemetry: { terminal: false },
        }),
      );
      await pacer.completeFrame(frameStartedAt);
    }
    const manifest: GameDatasetManifest = {
      schemaVersion: "game-dataset-v1",
      core: request.profile.core,
      profileId: request.profile.id,
      profileDigest: gameTargetProfileDigest(request.profile),
      preprocessingVersion: request.preprocessingVersion,
      actionCodec: request.actionCodec,
      seed: 0,
      seedMode: "uncontrolled",
      surface: "desktop",
      captureRegion: request.captureRegion,
      createdAt: new Date().toISOString(),
      samples,
    };
    const datasetPath = join(output, "manifest.json");
    await writeGameDatasetManifest(datasetPath, manifest);
    const realtime = pacer.metrics();
    await appendGameTrainingTrace(
      root,
      trace,
      "game_human_recording_completed",
      {
        sampleCount: samples.length,
        realtime,
      },
    );
    return {
      datasetPath,
      tracePath: join(paths.tracesRoot, `${trace.sessionId}.jsonl`),
      sampleCount: samples.length,
      lease: {
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt,
        requestHash: lease.requestHash,
      },
      realtime,
    };
  } catch (error) {
    await appendGameTrainingTrace(root, trace, "game_human_recording_stopped", {
      reason: recordingStopReason(error),
    }).catch(() => undefined);
    throw error;
  } finally {
    await recorder.close().catch(() => undefined);
  }
}

function assertRequest(request: DesktopHumanRecordingRequest): void {
  if (!request.profile.supportedSurfaces.includes("desktop")) {
    throw new Error("This Game profile is not approved for desktop recording.");
  }
  if (!request.windowTitle.trim() || !request.approvedBy.trim()) {
    throw new Error(
      "Desktop recording requires an approved window and operator.",
    );
  }
  if (
    !Number.isSafeInteger(request.durationMs) ||
    request.durationMs < 1_000 ||
    request.durationMs > 5 * 60_000
  ) {
    throw new Error(
      "Desktop recording duration must be between 1 second and 5 minutes.",
    );
  }
}

function assertLease(
  lease: GameControlLease,
  request: DesktopHumanRecordingRequest,
): void {
  const result = validateGameControlLease(lease, {
    core: request.profile.core,
    profileId: request.profile.id,
    windowTitle: request.windowTitle,
    captureRegion: request.captureRegion,
    control: request.profile.control,
  });
  if (!result.valid) throw new Error(result.reason);
}

function sanitizeDesktopInput(
  profile: GameTargetProfile,
  input: PythonDesktopInput,
): GameInputSample {
  if (
    input.heldKeys.some((key) => !profile.control.allowedKeys.includes(key))
  ) {
    throw new Error(
      "Desktop recorder returned a key outside the action allowlist.",
    );
  }
  const pointerX = finite(input.pointerX);
  const pointerY = finite(input.pointerY);
  const pointerDeltaX = finite(input.pointerDeltaX);
  const pointerDeltaY = finite(input.pointerDeltaY);
  return {
    timestampMs: Math.round(performance.now()),
    heldKeys: [...new Set(input.heldKeys)],
    primaryDown: profile.control.allowPrimaryClick ? input.primaryDown : false,
    ...(profile.control.aimMode === "absolute"
      ? { pointerX: clamp(pointerX, 0, 1), pointerY: clamp(pointerY, 0, 1) }
      : {}),
    ...(profile.control.aimMode === "relative"
      ? {
          pointerDeltaX: clamp(
            pointerDeltaX,
            -(profile.control.maxPointerDelta ?? 0),
            profile.control.maxPointerDelta ?? 0,
          ),
          pointerDeltaY: clamp(
            pointerDeltaY,
            -(profile.control.maxPointerDelta ?? 0),
            profile.control.maxPointerDelta ?? 0,
          ),
        }
      : {}),
  };
}

function finite(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) {
    throw new Error("Desktop recorder returned non-finite pointer data.");
  }
  return value;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Desktop recording was cancelled by the operator.");
  }
}

function recordingStopReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
