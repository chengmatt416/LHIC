import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runSharedCommand } from "./shared-skills.js";

describe("shared skills CLI", () => {
  it("reports a disabled registry when no workspace configuration exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-shared-cli-"));
    const databaseFile = join(directory, "memory", "skills.sqlite");
    try {
      await expect(
        runSharedCommand("status", ["--database", databaseFile]),
      ).resolves.toEqual({ enabled: false, databaseFile });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
