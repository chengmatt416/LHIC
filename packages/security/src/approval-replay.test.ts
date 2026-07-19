import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createActionApproval } from "./action-approval.js";
import { FileApprovalReplayStore } from "./approval-replay.js";

describe("FileApprovalReplayStore", () => {
  const action = {
    type: "click" as const,
    intent: "delete account",
    target: "#delete",
    methodPreference: ["dom" as const],
    riskLevel: "high" as const,
  };

  it("atomically reserves an approval once without storing the approver identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-approval-replay-"));
    const now = new Date("2026-07-19T00:00:00.000Z");
    const approval = createActionApproval(action, "operator@example.test", {
      now,
      expiresInMs: 60_000,
    });
    try {
      const firstStore = new FileApprovalReplayStore(directory, {
        now: () => now,
      });
      const secondStore = new FileApprovalReplayStore(directory, {
        now: () => now,
      });

      await expect(firstStore.reserve(approval)).resolves.toMatchObject({
        allowed: true,
      });
      await expect(secondStore.reserve(approval)).resolves.toMatchObject({
        allowed: false,
        reason: expect.stringContaining("already been used"),
      });

      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      expect(files[0]).not.toContain(approval.approvalId);
      const marker = await readFile(join(directory, files[0]!), "utf8");
      expect(marker).not.toContain(approval.approvedBy);
      expect(marker).toContain(approval.actionHash);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prunes expired reservation markers before accepting a new approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-approval-prune-"));
    let now = new Date("2026-07-19T00:00:00.000Z");
    const store = new FileApprovalReplayStore(directory, { now: () => now });
    try {
      const expired = createActionApproval(action, "operator@example.test", {
        now,
        expiresInMs: 1,
      });
      await expect(store.reserve(expired)).resolves.toMatchObject({
        allowed: true,
      });

      now = new Date("2026-07-19T00:00:01.000Z");
      const current = createActionApproval(action, "operator@example.test", {
        now,
        expiresInMs: 60_000,
      });
      await expect(store.reserve(current)).resolves.toMatchObject({
        allowed: true,
      });
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
