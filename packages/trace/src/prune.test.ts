import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pruneTraces } from "./prune.js";

describe("pruneTraces", () => {
  it("walks a directory and deletes files older than maxAgeDays", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "lhic-prune-"));
    try {
      const fileOld = join(tempDir, "old.jsonl");
      const fileNew = join(tempDir, "new.jsonl");
      const fileOther = join(tempDir, "ignored.txt");

      await writeFile(fileOld, "old data", "utf8");
      await writeFile(fileNew, "new data", "utf8");
      await writeFile(fileOther, "ignored data", "utf8");

      const fiveDaysAgo = (Date.now() - 5 * 24 * 60 * 60 * 1000) / 1000;
      await utimes(fileOld, fiveDaysAgo, fiveDaysAgo);

      const result = await pruneTraces(tempDir, 3);
      expect(result.deletedCount).toBe(1);
      expect(result.errors).toHaveLength(0);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
