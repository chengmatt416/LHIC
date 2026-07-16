import { describe, expect, it } from "vitest";

import { createMemoryDatabase } from "./skill-store.js";
import { SharedSkillStore } from "./shared-skill-store.js";

describe("shared skill SQLite cache", () => {
  it("mirrors approved snapshots, handles revocations, and deduplicates the outbox", () => {
    const database = createMemoryDatabase();
    try {
      const store = new SharedSkillStore(database);
      store.applySnapshot("registry", {
        skills: [
          {
            registryId: "registry",
            skillId: "shared-1",
            version: "v1",
            name: "shared-search",
            operationKey: "operation:search",
            fingerprint: "fingerprint",
            definition: { actions: [] },
            fastPathEligible: true,
            contentHash: "hash-1",
            updatedAt: "2026-07-16T00:00:00.000Z",
          },
        ],
        revokedSkillIds: [],
      });

      expect(
        store.findByFingerprint("registry", "operation:search", "fingerprint"),
      ).toMatchObject([{ skillId: "shared-1", fastPathEligible: true }]);
      expect(
        store.enqueueSubmission("registry", "submission", { token: "secret" }),
      ).toBe(true);
      expect(
        store.enqueueSubmission("registry", "submission", { token: "other" }),
      ).toBe(false);
      expect(store.listOutbox("registry")[0]?.payload).toEqual({
        token: "[REDACTED]",
      });

      store.applySnapshot("registry", {
        skills: [],
        revokedSkillIds: ["shared-1"],
      });
      expect(store.listApproved("registry")).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("keeps sync errors separate from the last successful cursor", () => {
    const database = createMemoryDatabase();
    try {
      const store = new SharedSkillStore(database);
      store.recordSyncSuccess("registry", "cursor-1");
      store.recordSyncFailure("registry", "network\nfailed");
      expect(store.getSyncState("registry")).toMatchObject({
        cursor: "cursor-1",
        lastError: "network failed",
      });
    } finally {
      database.close();
    }
  });
});
