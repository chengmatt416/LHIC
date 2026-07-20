import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ensurePrivateDirectory } from "./private-directory.js";

describe("ensurePrivateDirectory", () => {
  it("tightens an existing workspace directory to owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-private-directory-"));
    try {
      const directory = join(root, ".lhic");
      await ensurePrivateDirectory(directory);

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
