import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertArtifactCompatible,
  createGameControlLease,
  gameTargetProfileDigest,
  getGameTargetProfile,
  readRegisteredLocalGameTarget,
  registerLocalGameTarget,
  validateGameControlLease,
} from "./index.js";

describe("game-training shared infrastructure", () => {
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
      metrics: { behaviorCloningLoss: 1, ppoReward: 0 },
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
});
