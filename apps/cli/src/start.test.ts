import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import { describe, expect, it } from "vitest";

import { startLocalRuntime } from "./start.js";

describe("startLocalRuntime", () => {
  it("creates a persistent SQLite database with the built-in skills preloaded", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-start-"));
    const databaseFile = join(directory, "memory", "skills.sqlite");
    try {
      const result = await startLocalRuntime(databaseFile);
      expect(result).toMatchObject({
        databaseFile,
        preloadedSkills: [
          "download_file",
          "fill_form",
          "login",
          "search",
          "test_web_flow",
        ],
      });

      const database = createMemoryDatabase(databaseFile);
      try {
        const store = new SkillStore(database);
        expect(store.get("search")).toMatchObject({
          lifecycle: "draft",
          definition: { source: "builtin" },
        });
      } finally {
        database.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
