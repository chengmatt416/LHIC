import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TaskJournalStore } from "./task-journal-store.js";

describe("TaskJournalStore", () => {
  it("round-trips resumable state in a private workspace file", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-task-journal-"));
    try {
      const store = new TaskJournalStore(root);
      await store.save({
        events: [
          {
            commandId: "task-1",
            status: "awaiting_approval",
            message: "Review the proposal.",
            createdAt: "2026-07-19T00:00:00.000Z",
          },
        ],
        pending: [
          {
            commandId: "task-1",
            goal: "Open the documentation page",
            phase: "source",
            source: {
              id: "codex-cli",
              kind: "codex-cli",
              label: "Codex CLI",
              enabled: true,
            },
          },
        ],
      });

      const loaded = await store.load();
      expect(loaded.pending[0]).toMatchObject({
        commandId: "task-1",
        phase: "source",
      });
      expect(
        await readFile(join(root, ".lhic/task-journal.json"), "utf8"),
      ).not.toContain("secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops malformed events instead of restoring an unsafe state", async () => {
    const root = await mkdtemp(join(tmpdir(), "lhic-task-journal-"));
    try {
      const directory = join(root, ".lhic");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "task-journal.json"),
        JSON.stringify({
          events: [
            {
              commandId: "bad",
              status: "executing-anything",
              message: "unsafe",
              createdAt: "now",
            },
          ],
          pending: [],
        }),
      );

      expect((await new TaskJournalStore(root).load()).events).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
