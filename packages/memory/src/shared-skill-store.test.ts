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

import { describe, expect, it } from "vitest";

import { SharedSkillStore } from "./shared-skill-store.js";

describe("SharedSkillStore snapshot guard", () => {
  function snapshotSkill(content: string, skillId = "s1") {
    return {
      registryId: "reg-1",
      skillId,
      version: "1.0.0",
      name: "skill",
      operationKey: "op-1",
      fingerprint: "fp-1",
      definition: { compiler: "shared-skill-v1", actions: [{ text: content }] },
      fastPathEligible: true,
      contentHash: content,
      updatedAt: new Date().toISOString(),
    } as never;
  }

  it("never silently replaces a stored skill without verified trust", () => {
    const store = new SharedSkillStore(createMemoryDatabase(":memory:"));
    store.applySnapshot("reg-1", {
      skills: [snapshotSkill("hash-a")],
      revokedSkillIds: [],
    });
    // An unverified content change to an existing skill is refused.
    const result = store.applySnapshot("reg-1", {
      skills: [snapshotSkill("hash-b")],
      revokedSkillIds: [],
    });
    expect(result.keptLocal).toEqual(["s1"]);
    expect(result.replaced).toEqual([]);
    expect(store.listApproved("reg-1")[0]?.contentHash).toBe("hash-a");
    // A verified (trusted) change is applied.
    const trusted = store.applySnapshot(
      "reg-1",
      { skills: [snapshotSkill("hash-c")], revokedSkillIds: [] },
      { isTrusted: () => true },
    );
    expect(trusted.replaced).toEqual(["s1"]);
    expect(store.listApproved("reg-1")[0]?.contentHash).toBe("hash-c");
    // New skills are inserted without replacement concerns.
    store.applySnapshot("reg-1", {
      skills: [snapshotSkill("hash-new", "s2")],
      revokedSkillIds: [],
    });
    expect(store.listApproved("reg-1")).toHaveLength(2);
  });

  it("removes revoked skills", () => {
    const store = new SharedSkillStore(createMemoryDatabase(":memory:"));
    store.applySnapshot("reg-1", {
      skills: [snapshotSkill("hash-a")],
      revokedSkillIds: [],
    });
    store.applySnapshot("reg-1", {
      skills: [],
      revokedSkillIds: ["s1"],
    });
    expect(store.listApproved("reg-1")).toHaveLength(0);
  });
});
