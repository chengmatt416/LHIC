import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runGameTrainingCommand } from "./game-training.js";

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
});
