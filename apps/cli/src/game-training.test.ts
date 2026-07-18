import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  gameTargetProfileDigest,
  getGameTargetProfile,
} from "@lhic/game-training";

import {
  matchesFocusedGameWindowTitle,
  runGameTrainingCommand,
} from "./game-training.js";

describe("game-training CLI", () => {
  it("registers a local 2D target without accepting it through the 3D core", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-game-cli-"));
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "index.html"), "<!doctype html>", "utf8");

    await expect(
      runGameTrainingCommand([
        "2d",
        "setup",
        "star-trooper",
        "--source",
        source,
        "--root",
        join(root, "runtime"),
      ]),
    ).resolves.toMatchObject({ core: "2d", profile: "star-trooper" });
    await expect(
      runGameTrainingCommand([
        "3d",
        "setup",
        "star-trooper",
        "--source",
        source,
      ]),
    ).rejects.toThrow("2d target");
  });

  it("creates a five-minute desktop lease bound to the selected 2D core", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-game-cli-lease-"));
    const leasePath = join(root, "lease.json");

    await expect(
      runGameTrainingCommand([
        "2d",
        "lease",
        "star-trooper",
        "--window-title",
        "Star Trooper",
        "--region",
        "0,0,800,600",
        "--approved-by",
        "operator",
        "--output",
        leasePath,
      ]),
    ).resolves.toMatchObject({ command: "lease", core: "2d" });

    await expect(readFile(leasePath, "utf8")).resolves.toContain(
      '"core": "2d"',
    );
  });

  it("registers the approved remote FPS without accepting a local source", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-remote-game-cli-"));

    await expect(
      runGameTrainingCommand([
        "3d",
        "setup",
        "epic-shooter-3d",
        "--root",
        join(root, "runtime"),
      ]),
    ).resolves.toMatchObject({
      core: "3d",
      profile: "epic-shooter-3d",
      target: {
        schemaVersion: "remote-game-target-v1",
        url: "https://www.epicshooter3d.com/",
      },
    });

    await expect(
      runGameTrainingCommand(["2d", "setup", "epic-shooter-3d"]),
    ).rejects.toThrow("3d target");
  });

  it("permits a lease for the existing interactive remote FPS window", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-remote-game-lease-"));
    const leasePath = join(root, "lease.json");

    await expect(
      runGameTrainingCommand([
        "3d",
        "lease",
        "epic-shooter-3d",
        "--window-title",
        "Epic Shooter 3D",
        "--region",
        "0,0,1024,768",
        "--approved-by",
        "operator",
        "--output",
        leasePath,
      ]),
    ).resolves.toMatchObject({ command: "lease", core: "3d" });

    await expect(readFile(leasePath, "utf8")).resolves.toContain(
      '"profileId": "epic-shooter-3d"',
    );
  });

  it("keeps the external FPS lease focused across Chrome audio-title markers", () => {
    expect(
      matchesFocusedGameWindowTitle(
        "epic-shooter-3d",
        "Epic Shooter 3D - Google Chrome",
        "Epic Shooter 3D - \u97f3\u8a0a\u64ad\u653e\u4e2d - Google Chrome",
      ),
    ).toBe(true);
    expect(
      matchesFocusedGameWindowTitle(
        "epic-shooter-3d",
        "Epic Shooter 3D - Google Chrome",
        "Another Game - \u97f3\u8a0a\u64ad\u653e\u4e2d - Google Chrome",
      ),
    ).toBe(false);
    expect(
      matchesFocusedGameWindowTitle(
        "nemesis",
        "Nemesis",
        "Nemesis - Google Chrome",
      ),
    ).toBe(false);
  });

  it("refuses to fit a low-diversity action-game recording", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-game-quality-"));
    const datasetPath = join(root, "manifest.json");
    const profile = getGameTargetProfile("epic-shooter-3d");
    await writeFile(
      datasetPath,
      JSON.stringify({
        schemaVersion: "game-dataset-v1",
        core: "3d",
        profileId: profile.id,
        profileDigest: gameTargetProfileDigest(profile),
        preprocessingVersion: "game-3d-rgb-96-history-4-v1",
        actionCodec: "game-3d-fps-action-v1",
        seed: 1,
        surface: "desktop",
        createdAt: "2026-07-17T00:00:00.000Z",
        samples: Array.from({ length: 16 }, (_, index) => ({
          timestampMs: index,
          frame: `frames/${index}.png`,
          input: {
            heldKeys: ["KeyW"],
            primaryDown: false,
            pointerDeltaX: 0,
            pointerDeltaY: 0,
          },
          telemetry: { terminal: false },
        })),
      }),
      "utf8",
    );

    await expect(
      runGameTrainingCommand([
        "3d",
        "fit",
        "epic-shooter-3d",
        "--dataset",
        datasetPath,
        "--root",
        root,
      ]),
    ).rejects.toThrow("at least two movement actions");
  });
});
