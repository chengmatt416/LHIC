import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertArtifactCompatible,
  createGamePolicyPackage,
  verifyGamePolicyPackage,
  createGameControlLease,
  createGameEpisodeSample,
  gameTargetProfileDigest,
  getGameTargetProfile,
  readRegisteredLocalGameTarget,
  readRegisteredRemoteGameTarget,
  registerLocalGameTarget,
  registerRemoteGameTarget,
  runtimeAssetPath,
  startLocalGameTargetServer,
  validateGameControlLease,
  validateGameDatasetManifest,
} from "./index.js";

describe("game-training shared infrastructure", () => {
  it("uses unpacked runtime assets when invoked from an Electron ASAR", () => {
    expect(
      runtimeAssetPath(
        "/Applications/LHIC.app/Contents/Resources/app.asar/node_modules/@lhic/game-training/python/worker.py",
      ),
    ).toContain(
      "app.asar.unpacked/node_modules/@lhic/game-training/python/worker.py",
    );
  });

  it("keeps local game target registrations inside their core directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-game-training-"));
    const source = join(root, "star-trooper");
    await writeFile(join(root, "placeholder"), "", "utf8");
    await mkdir(source);
    await writeFile(join(source, "index.html"), "<!doctype html>", "utf8");
    const profile = getGameTargetProfile("star-trooper");

    await registerLocalGameTarget(profile, source, join(root, "runtime"));

    await expect(
      readRegisteredLocalGameTarget(profile, join(root, "runtime")),
    ).resolves.toMatchObject({ profileId: "star-trooper", core: "2d" });
  });

  it("requires the exact allowlisted remote FPS origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-remote-game-training-"));
    const profile = getGameTargetProfile("epic-shooter-3d");

    await registerRemoteGameTarget(profile, join(root, "runtime"));

    await expect(
      readRegisteredRemoteGameTarget(profile, join(root, "runtime")),
    ).resolves.toMatchObject({
      profileId: "epic-shooter-3d",
      core: "3d",
      url: "https://www.epicshooter3d.com/",
      allowedOrigins: ["https://www.epicshooter3d.com"],
    });
  });

  it("refuses remote target registration without a post-start readiness check", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-remote-game-training-"));
    const profile = getGameTargetProfile("epic-shooter-3d");
    const telemetry = { ...profile.telemetry };
    delete telemetry.readySelector;

    await expect(
      registerRemoteGameTarget(
        {
          ...profile,
          telemetry,
        },
        join(root, "runtime"),
      ),
    ).rejects.toThrow("readiness check");
  });

  it("binds desktop control leases to the exact target, core, and region", () => {
    const profile = getGameTargetProfile("nemesis");
    const request = {
      core: profile.core,
      profileId: profile.id,
      windowTitle: "Nemesis",
      captureRegion: { x: 1, y: 2, width: 640, height: 480 },
      control: profile.control,
    } as const;
    const lease = createGameControlLease(request, "operator", {
      now: new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(
      validateGameControlLease(
        lease,
        request,
        new Date("2026-07-17T00:04:00.000Z"),
      ),
    ).toMatchObject({ valid: true });
    expect(
      validateGameControlLease(
        lease,
        { ...request, core: "2d", profileId: "star-trooper" },
        new Date("2026-07-17T00:04:00.000Z"),
      ),
    ).toMatchObject({ valid: false });
  });

  it("rejects absolute or escaping dataset frame paths", () => {
    const sample = {
      timestampMs: 0,
      frame: "/tmp/frame.png",
      input: { timestampMs: 0, heldKeys: [], primaryDown: false },
      telemetry: { terminal: false },
    };
    expect(() => createGameEpisodeSample(sample)).toThrow("safe relative");
    expect(() =>
      validateGameDatasetManifest({
        schemaVersion: "game-dataset-v1",
        core: "2d",
        profileId: "star-trooper",
        profileDigest: "digest",
        preprocessingVersion: "test",
        actionCodec: "test",
        seed: 1,
        surface: "browser",
        createdAt: "2026-07-18T00:00:00.000Z",
        samples: [{ ...sample, frame: "C:\\temp\\frame.png" }],
      }),
    ).toThrow("invalid");
  });

  it("does not serve a local target symlink that resolves outside its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-game-target-server-"));
    const source = join(root, "source");
    const secret = join(root, "outside.txt");
    await mkdir(source);
    await writeFile(join(source, "index.html"), "<!doctype html>", "utf8");
    await writeFile(secret, "not-a-game-asset", "utf8");
    await symlink(secret, join(source, "outside.txt"));
    const server = await startLocalGameTargetServer(source);

    try {
      expect((await fetch(`${server.url}outside.txt`)).status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("rejects artifacts from a different training core", () => {
    const profile = getGameTargetProfile("star-trooper");
    const artifact = {
      schemaVersion: "game-policy-v1" as const,
      core: "3d" as const,
      profileId: "nemesis",
      profileDigest: "a".repeat(64),
      preprocessingVersion: "game-3d-rgb-96-history-4-v1",
      frameSpec: { width: 96, height: 96, channels: 3 as const, history: 4 },
      actionCodec: "game-3d-fps-action-v1",
      weightsFile: "weights.pt",
      weightsSha256: "b".repeat(64),
      training: {
        algorithm: "behavior-cloning-v1" as const,
        seed: 1,
        datasetSha256: "c".repeat(64),
        validationSplit: 0.2,
        trainingSampleCount: 12,
        validationSampleCount: 4,
      },
      metrics: {
        behaviorCloningLoss: 1,
        datasetReward: 0,
        validationLoss: 1,
        validationActionAccuracy: 0.5,
      },
      createdAt: "2026-07-17T00:00:00.000Z",
    };

    expect(() =>
      assertArtifactCompatible(
        artifact,
        "2d",
        profile,
        gameTargetProfileDigest(profile),
      ),
    ).toThrow("different training core");
    expect(() =>
      assertArtifactCompatible(
        {
          ...artifact,
          core: "2d",
          profileId: profile.id,
          profileDigest: gameTargetProfileDigest(profile),
        },
        "2d",
        profile,
        gameTargetProfileDigest(profile),
        {
          actionCodec: "game-2d-action-v1",
          preprocessingVersion: "game-2d-rgb-128-history-2-v1",
          frameSpec: { width: 128, height: 128, channels: 3, history: 2 },
        },
      ),
    ).toThrow("incompatible action or preprocessing codec");
  });

  it("creates a reviewable policy-only package without any raw game dataset", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-policy-package-"));
    const artifactDirectory = join(root, "artifact");
    await mkdir(artifactDirectory);
    const weights = Buffer.from("verified-policy-weights");
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
    const report = join(root, "evaluation.json");
    await writeFile(report, JSON.stringify({ episodes: 10, successRate: 0.8 }));

    const created = await createGamePolicyPackage({
      artifactPath: join(artifactDirectory, "artifact.json"),
      evaluationReportPath: report,
      destinationDirectory: join(root, "policy-package"),
    });

    expect(created.manifest).toMatchObject({
      schemaVersion: "game-policy-package-v1",
      core: "2d",
      profileId: "star-trooper",
      actionMapping: { codec: "game-2d-action-v1" },
      files: {
        artifact: { name: "artifact.json" },
        weights: { name: "weights.pt" },
        evaluationReport: { name: "evaluation-report.json" },
      },
    });
    expect(await readFile(created.weightsPath)).toEqual(weights);
    expect((await readFile(created.bundlePath)).subarray(0, 4)).toEqual(
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    );
    expect(created.bundleSha256).toHaveLength(64);
    await expect(
      verifyGamePolicyPackage({
        manifestPath: created.manifestPath,
        bundlePath: created.bundlePath,
      }),
    ).resolves.toMatchObject({
      bundleSha256: created.bundleSha256,
      manifest: { packageId: created.manifest.packageId },
    });
    const packageManifest = await readFile(created.manifestPath, "utf8");
    expect(packageManifest).not.toContain("datasetPath");
    expect(packageManifest).not.toContain("rawData");
    expect(packageManifest).not.toContain("inputEvents");

    await writeFile(created.bundlePath, "tampered");
    await expect(
      verifyGamePolicyPackage({
        manifestPath: created.manifestPath,
        bundlePath: created.bundlePath,
      }),
    ).rejects.toThrow("unexpected data");

    await expect(
      createGamePolicyPackage({
        artifactPath: join(artifactDirectory, "artifact.json"),
        evaluationReportPath: await unsafeReport(root),
        destinationDirectory: join(root, "unsafe-policy-package"),
      }),
    ).rejects.toThrow("raw gameplay recordings");
  });
});

async function unsafeReport(root: string): Promise<string> {
  const path = join(root, "unsafe-evaluation.json");
  await writeFile(path, JSON.stringify({ frames: ["frame-0001.png"] }));
  return path;
}
