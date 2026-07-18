import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TaskSourceStore } from "./task-source-store.js";

describe("TaskSourceStore", () => {
  it("persists source metadata without a credential value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-task-sources-"));
    try {
      const store = new TaskSourceStore(directory);
      await store.save([
        {
          id: "openai",
          kind: "openai-responses",
          label: "OpenAI Responses",
          model: "gpt-test",
          credentialId: "openai-keychain-id",
          enabled: true,
        },
      ]);

      await expect(store.load()).resolves.toEqual([
        expect.objectContaining({ credentialId: "openai-keychain-id" }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
