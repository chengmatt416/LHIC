import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getGameTargetProfile } from "@lhic/game-training";

import {
  createEmbeddedGameTrainingArguments,
  GameService,
} from "./game-service.js";

describe("GameService", () => {
  it("runs a local human-play recorder without relying on a global CLI", async () => {
    const recordHumanPlay = vi.fn().mockResolvedValue({
      datasetPath:
        "/workspace/.lhic/game-training/2d/datasets/run/manifest.json",
      tracePath: "/workspace/.lhic/game-training/2d/traces/run.jsonl",
      sampleCount: 24,
      lease: {
        leaseId: "lease-1",
        expiresAt: "2026-07-18T00:05:00.000Z",
        requestHash: "a".repeat(64),
      },
      realtime: {
        targetFrameRateHz: 20,
        targetFrameMs: 50,
        frameCount: 24,
        processingP50Ms: 2,
        processingP95Ms: 3,
        frameP95Ms: 50,
        missedDeadlineCount: 0,
        observedFrameRateHz: 20,
      },
    });
    const service = new GameService({
      recordHumanPlay,
      inspectRuntime: readyRuntime,
    });
    const updates: string[] = [];
    service.subscribe((update) => updates.push(update.status));

    const job = await service.run(
      {
        core: "2d",
        action: "record",
        profileId: "star-trooper",
        windowTitle: "Star Trooper",
        captureRegion: { x: 0, y: 0, width: 640, height: 480 },
        durationMs: 1_000,
        approvedBy: "operator",
      },
      "/workspace",
    );

    await vi.waitFor(() => {
      expect(service.status(job.id).status).toBe("completed");
    });
    expect(job.command).toEqual(["desktop", "game", "record", "star-trooper"]);
    expect(recordHumanPlay).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/workspace/.lhic/game-training",
        windowTitle: "Star Trooper",
        captureRegion: { x: 0, y: 0, width: 640, height: 480 },
      }),
    );
    expect(service.status(job.id).report).toMatchObject({
      localOnly: true,
      sampleCount: 24,
    });
    expect(updates).toEqual(["running", "completed"]);
  });

  it("cancels an in-flight local recording through its abort signal", async () => {
    let signal: AbortSignal | undefined;
    const service = new GameService({
      inspectRuntime: readyRuntime,
      recordHumanPlay: vi.fn(
        (request: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            signal = request.signal;
            request.signal?.addEventListener("abort", () =>
              reject(new Error("cancelled")),
            );
          }),
      ),
    });
    const job = await service.run(
      {
        core: "2d",
        action: "record",
        profileId: "star-trooper",
        windowTitle: "Star Trooper",
        captureRegion: { x: 0, y: 0, width: 640, height: 480 },
        durationMs: 1_000,
        approvedBy: "operator",
      },
      "/workspace",
    );

    service.cancel(job.id);
    expect(signal?.aborted).toBe(true);
    expect(service.status(job.id).status).toBe("cancelled");
  });

  it("does not permit policy playback without a verified local artifact", async () => {
    const service = new GameService({ inspectRuntime: readyRuntime });
    await expect(
      service.run(
        {
          core: "3d",
          action: "play",
          profileId: "nemesis",
        },
        "/workspace",
      ),
    ).rejects.toThrow("local resource path");
  });

  it("requires the local training runtime before recording can start", async () => {
    const service = new GameService({
      inspectRuntime: async () => ({
        python: "/workspace/.lhic/game-training/venv/bin/python",
        ready: false,
        packages: {},
        platform: "darwin",
        detail: "runtime not installed",
      }),
    });
    await expect(
      service.run(
        {
          core: "2d",
          action: "record",
          profileId: "star-trooper",
          windowTitle: "Star Trooper",
          captureRegion: { x: 0, y: 0, width: 640, height: 480 },
          durationMs: 1_000,
          approvedBy: "operator",
        },
        "/workspace",
      ),
    ).rejects.toThrow("runtime not installed");
  });

  it("constructs bounded packaged-worker arguments for approved policy workflows", () => {
    const profile = getGameTargetProfile("star-trooper");
    expect(
      createEmbeddedGameTrainingArguments(
        {
          core: "2d",
          action: "fit",
          profileId: "star-trooper",
          resourcePath: ".lhic/game-training/2d/datasets/demo/manifest.json",
        },
        profile,
        "/workspace",
      ),
    ).toEqual([
      "2d",
      "fit",
      "star-trooper",
      "--root",
      "/workspace/.lhic/game-training",
      "--dataset",
      "/workspace/.lhic/game-training/2d/datasets/demo/manifest.json",
    ]);
    expect(() =>
      createEmbeddedGameTrainingArguments(
        {
          core: "2d",
          action: "fit",
          profileId: "star-trooper",
          resourcePath: "../outside/manifest.json",
        },
        profile,
        "/workspace",
      ),
    ).toThrow("active workspace");
  });

  it("prepares the local Python environment only after an explicit Game Lab request", async () => {
    const inspectRuntime = vi.fn().mockResolvedValue({
      python: "/workspace/.lhic/game-training/venv/bin/python",
      ready: false,
      packages: {},
      platform: "darwin",
      detail: "runtime not installed",
    });
    const prepareRuntime = vi.fn().mockResolvedValue({
      python: "/workspace/.lhic/game-training/venv/bin/python",
      ready: true,
      packages: { numpy: true },
      platform: "darwin",
    });
    const service = new GameService({ inspectRuntime, prepareRuntime });

    await expect(
      service.inspectEnvironment("/workspace"),
    ).resolves.toMatchObject({
      ready: false,
    });
    await expect(
      service.prepareEnvironment("/workspace"),
    ).resolves.toMatchObject({
      ready: true,
    });
    expect(inspectRuntime).toHaveBeenCalledWith(
      "/workspace/.lhic/game-training/venv/bin/python",
    );
    expect(prepareRuntime).toHaveBeenCalledWith({
      environmentRoot: "/workspace/.lhic/game-training/venv",
    });
  });

  it("keeps policy-package source and destination paths inside the active workspace", async () => {
    const service = new GameService();
    await expect(
      service.packagePolicy(
        {
          artifactPath: "../outside/artifact.json",
          destinationDirectory: ".lhic/game-training/policy-packages/review",
        },
        "/workspace",
      ),
    ).rejects.toThrow("active workspace");
  });

  it("rebuilds policy submission metadata from the verified local bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-game-submission-"));
    const artifactDirectory = join(root, "artifact");
    await mkdir(artifactDirectory);
    const weights = Buffer.from("game-policy-weights");
    await writeFile(join(artifactDirectory, "weights.pt"), weights);
    await writeFile(
      join(artifactDirectory, "artifact.json"),
      `${JSON.stringify({
        schemaVersion: "game-policy-v1",
        core: "2d",
        profileId: "star-trooper",
        profileDigest: "a".repeat(64),
        preprocessingVersion: "game-2d-rgb-128-history-2-v1",
        frameSpec: { width: 128, height: 128, channels: 3, history: 2 },
        actionCodec: "game-2d-action-v1",
        weightsFile: "weights.pt",
        weightsSha256: createHash("sha256").update(weights).digest("hex"),
        training: {
          algorithm: "behavior-cloning-v1",
          seed: 1,
          datasetSha256: "c".repeat(64),
          validationSplit: 0.2,
          trainingSampleCount: 12,
          validationSampleCount: 4,
        },
        metrics: {
          behaviorCloningLoss: 0.2,
          datasetReward: 1.5,
          validationLoss: 0.4,
          validationActionAccuracy: 0.75,
        },
        createdAt: "2026-07-18T00:00:00.000Z",
      })}\n`,
    );
    const service = new GameService();
    const policyPackage = await service.packagePolicy(
      {
        artifactPath: join(artifactDirectory, "artifact.json"),
        destinationDirectory: join(root, "review"),
      },
      root,
    );

    const submission = await service.preparePolicySubmission(
      {
        package: { ...policyPackage, packageId: "f".repeat(64) },
        bundleUrl: "https://packages.example.test/policy-package.zip",
        version: "v1",
      },
      root,
    );

    expect(submission.package.packageId).toBe(policyPackage.packageId);
    expect(submission.package.bundleSha256).toBe(policyPackage.bundleSha256);
    expect(submission.bundleUrl).toBe(
      "https://packages.example.test/policy-package.zip",
    );
  });
});

async function readyRuntime() {
  return {
    python: "/workspace/.lhic/game-training/venv/bin/python",
    ready: true,
    packages: { numpy: true },
    platform: "darwin",
  };
}
