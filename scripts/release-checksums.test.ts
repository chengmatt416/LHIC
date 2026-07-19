import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createSha256Manifest } from "./generate-sha256-manifest.mjs";

describe("release checksum manifest", () => {
  it("writes deterministic SHA-256 entries for installer artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-release-manifest-"));
    try {
      await writeFile(
        join(directory, "lhic-control-center-0.1.2-x64.exe"),
        "windows artifact",
      );
      await writeFile(
        join(directory, "lhic-control-center-0.1.2-arm64.dmg"),
        "mac artifact",
      );
      await writeFile(join(directory, "notes.txt"), "not an installer");

      const result = await createSha256Manifest(directory, "0.1.2");
      const manifest = await readFile(result.outputPath, "utf8");

      expect(result.artifacts).toBe(2);
      expect(manifest).toContain("lhic-control-center-0.1.2-arm64.dmg");
      expect(manifest).toContain("lhic-control-center-0.1.2-x64.exe");
      expect(manifest.indexOf("arm64.dmg")).toBeLessThan(
        manifest.indexOf("x64.exe"),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when no installer artifacts are present", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-release-empty-"));
    try {
      await expect(createSha256Manifest(directory, "0.1.2")).rejects.toThrow(
        "No desktop installer artifacts",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
