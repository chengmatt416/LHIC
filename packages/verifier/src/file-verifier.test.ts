import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyFile } from "./file-verifier.js";

describe("verifyFile", () => {
  it("requires the verified file to resolve inside an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-file-root-"));
    const outside = await mkdtemp(join(tmpdir(), "lhic-file-outside-"));
    const insidePath = join(root, "report.txt");
    const outsidePath = join(outside, "secret.txt");
    await writeFile(insidePath, "verified");
    await writeFile(outsidePath, "not an allowed artifact");

    try {
      await expect(
        verifyFile({
          filePath: insidePath,
          allowedRoot: root,
          extension: ".txt",
          minSize: 1,
        }),
      ).resolves.toMatchObject({ success: true });
      await expect(
        verifyFile({ filePath: outsidePath, allowedRoot: root }),
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("outside the allowed root"),
      });
      await expect(
        verifyFile({ filePath: root, allowedRoot: root }),
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("outside the allowed root"),
      });
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it("fails closed when a file condition omits its root", async () => {
    await expect(
      verifyFile({ filePath: join(tmpdir(), "unscoped.txt") }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("allowedRoot"),
    });
  });
});
