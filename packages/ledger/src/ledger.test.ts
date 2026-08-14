import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SideEffectLedgerEntry } from "@lhic/schema";

import { SideEffectLedger } from "./side-effect-ledger.js";
import { WorkspaceConflictStore } from "./workspace-conflicts.js";

function entry(
  actionId: string,
  state: SideEffectLedgerEntry["state"] = "proposed",
): SideEffectLedgerEntry {
  const now = new Date().toISOString();
  return {
    schemaVersion: "lhic-side-effect-ledger-v1",
    actionId,
    actionHash: "a".repeat(64),
    taskId: "task-1",
    surface: "browser",
    sideEffectClass: "external_write",
    state,
    createdAt: now,
    updatedAt: now,
  };
}

describe("SideEffectLedger", () => {
  let directory: string;
  let ledger: SideEffectLedger;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-ledger-"));
    ledger = new SideEffectLedger({
      databaseFile: join(directory, "ledger.sqlite"),
    });
  });

  afterEach(async () => {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("persists entries and rejects duplicate action IDs", () => {
    ledger.put(entry("a1"));
    expect(() => ledger.put(entry("a1"))).toThrow(/already exists/);
    expect(ledger.get("a1")?.state).toBe("proposed");
  });

  it("enforces the state machine and rejects invalid transitions", () => {
    ledger.put(entry("a1"));
    ledger.transition("a1", "approved");
    ledger.transition("a1", "dispatching");
    ledger.transition("a1", "possibly_committed");
    ledger.transition("a1", "executed");
    ledger.transition("a1", "verified");
    expect(ledger.get("a1")?.state).toBe("verified");
    expect(() => ledger.transition("a1", "dispatching")).toThrow(
      /Invalid ledger transition/,
    );
    expect(() => ledger.transition("a1", "executed")).toThrow(
      /Invalid ledger transition/,
    );
  });

  it("rejects transitions of unknown entries", () => {
    expect(() => ledger.transition("ghost", "approved")).toThrow(
      /unknown ledger entry/,
    );
  });

  it("exposes ambiguous entries for recovery", () => {
    ledger.put(entry("a1", "possibly_committed"));
    ledger.put(entry("a2", "verified"));
    ledger.put(entry("a3", "dispatching"));
    const ambiguous = ledger.ambiguousForRecovery().map((e) => e.actionId);
    expect(ambiguous).toContain("a1");
    expect(ambiguous).toContain("a3");
    expect(ambiguous).not.toContain("a2");
    expect(ledger.verified("a2")).toBe(true);
  });

  it("rejects malformed entries at the trust boundary", () => {
    expect(() =>
      ledger.put({ ...entry("a9"), actionHash: "not-a-hash" }),
    ).toThrow(/malformed ledger entry/);
  });

  it("tracks approval scope usage", () => {
    expect(ledger.scopeUsage("approval-1")).toBe(0);
    expect(ledger.consumeScopeAction("approval-1")).toBe(1);
    expect(ledger.consumeScopeAction("approval-1")).toBe(2);
    expect(ledger.scopeUsage("approval-1")).toBe(2);
  });
});

describe("WorkspaceConflictStore", () => {
  let directory: string;
  let store: WorkspaceConflictStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-conflicts-"));
    store = new WorkspaceConflictStore({
      databaseFile: join(directory, "ledger.sqlite"),
    });
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("notifies stale readers of a file change", () => {
    store.recordRead("agent-a", "task-1", "src/a.ts", "hash-old");
    store.recordRead("agent-b", "task-1", "src/a.ts", "hash-old");
    store.recordRead("agent-b", "task-1", "src/other.ts", "hash-x");
    const conflicts = store.onFileChanged("task-1", "src/a.ts", "hash-new", {
      writerAgentId: "agent-a",
    });
    // agent-a wrote the change; agent-b is stale. Different file: no conflict.
    expect(conflicts.map((c) => c.path)).toEqual(["src/a.ts"]);
    expect(conflicts[0]?.oldHash).toBe("hash-old");
    expect(conflicts[0]?.newHash).toBe("hash-new");
    expect(conflicts[0]?.writerAgentId).toBe("agent-a");
  });

  it("gates a stale agent's write until re-read or acknowledgement", () => {
    store.recordRead("agent-b", "task-1", "src/a.ts", "hash-old");
    store.onFileChanged("task-1", "src/a.ts", "hash-new", {
      writerAgentId: "agent-a",
    });
    expect(
      store.pendingConflictForWrite("agent-b", "task-1", "src/a.ts"),
    ).toBeDefined();
    // Re-read: the read set now matches the new hash; the gate opens.
    store.recordRead("agent-b", "task-1", "src/a.ts", "hash-new");
    expect(
      store.pendingConflictForWrite("agent-b", "task-1", "src/a.ts"),
    ).toBeUndefined();
  });

  it("allows explicit acknowledgement to open the gate", () => {
    store.recordRead("agent-b", "task-1", "src/a.ts", "hash-old");
    const [conflict] = store.onFileChanged("task-1", "src/a.ts", "hash-new");
    store.acknowledgeConflict(conflict!.conflictId, "agent-b");
    expect(
      store.pendingConflictForWrite("agent-b", "task-1", "src/a.ts"),
    ).toBeUndefined();
  });

  it("survives a store restart (OMP process restart)", () => {
    store.recordRead("agent-b", "task-1", "src/a.ts", "hash-old");
    store.onFileChanged("task-1", "src/a.ts", "hash-new");
    store.close();
    const reopened = new WorkspaceConflictStore({
      databaseFile: join(directory, "ledger.sqlite"),
    });
    expect(
      reopened.pendingConflictForWrite("agent-b", "task-1", "src/a.ts"),
    ).toBeDefined();
    expect(reopened.conflictsForTask("task-1")).toHaveLength(1);
    reopened.close();
  });

  it("does not conflict when content returns to the same hash", () => {
    store.recordRead("agent-b", "task-1", "src/a.ts", "hash-old");
    const first = store.onFileChanged("task-1", "src/a.ts", "hash-other");
    expect(first).toHaveLength(1);
    // A change back to the hash agent-b read creates no new conflict for it.
    const second = store.onFileChanged("task-1", "src/a.ts", "hash-old");
    expect(second).toHaveLength(0);
  });
});
