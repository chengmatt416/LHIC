import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SideEffectLedger } from "@lhic/ledger";

import { LedgerCoordinator } from "./ledger-coordinator.js";

describe("LedgerCoordinator crash recovery", () => {
  let directory: string;
  let ledger: SideEffectLedger;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-coordinator-"));
    ledger = new SideEffectLedger({
      databaseFile: join(directory, "ledger.sqlite"),
    });
  });

  afterEach(async () => {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("walks the full lifecycle to verified", () => {
    const coordinator = new LedgerCoordinator({
      ledger,
      taskId: "task-1",
      surface: "browser",
    });
    coordinator.begin("step-1", "a".repeat(64), "external_write");
    coordinator.approve("step-1");
    coordinator.beforeDispatch("step-1");
    coordinator.afterDispatch("step-1");
    coordinator.verifySucceeded("step-1", ["evidence:x"]);
    expect(ledger.get("step-1")?.state).toBe("verified");
    expect(ledger.verified("step-1")).toBe(true);
  });

  it("recovery: physical action happened before crash is never repeated", () => {
    const first = new LedgerCoordinator({
      ledger,
      taskId: "task-1",
      surface: "browser",
    });
    first.begin("step-1", "a".repeat(64), "destructive");
    first.beforeDispatch("step-1");
    // "Process died" immediately after the physical side effect, before the
    // execution result frame: the ledger stays possibly_committed.
    expect(ledger.get("step-1")?.state).toBe("possibly_committed");

    // A new process (fresh coordinator over the same durable ledger).
    const restarted = new LedgerCoordinator({
      ledger,
      taskId: "task-1",
      surface: "browser",
    });
    const pending = restarted.recoverPending();
    expect(pending.map((entry) => entry.actionId)).toEqual(["step-1"]);
    // Re-observation proves the side effect happened: marked verified, so the
    // runner skips execution instead of repeating it.
    const outcome = restarted.recover("step-1", {
      sideEffectHappened: true,
      evidenceRefs: ["evidence:observed"],
    });
    expect(outcome).toBe("verified");
    expect(ledger.verified("step-1")).toBe(true);
    expect(ledger.get("step-1")?.verifierEvidenceRefs).toEqual([
      "evidence:observed",
    ]);
    expect(restarted.recoverPending()).toEqual([]);
  });

  it("recovery: unprovable side effects become needs_resolution, never blindly replayed", () => {
    const first = new LedgerCoordinator({
      ledger,
      taskId: "task-1",
      surface: "desktop",
    });
    first.begin("os-step", "b".repeat(64), "account_change");
    first.beforeDispatch("os-step");
    const restarted = new LedgerCoordinator({
      ledger,
      taskId: "task-1",
      surface: "desktop",
    });
    const outcome = restarted.recover("os-step", {
      sideEffectHappened: false,
      evidenceRefs: [],
    });
    expect(outcome).toBe("needs_resolution");
    expect(ledger.get("os-step")?.state).toBe("needs_resolution");
    // A needs_resolution entry must not be picked up as retryable.
    expect(restarted.recoverPending()).toEqual([]);
  });

  it("verified entries never repeat and other tasks are isolated", () => {
    const coordinator = new LedgerCoordinator({
      ledger,
      taskId: "task-1",
      surface: "browser",
    });
    coordinator.begin("done", "c".repeat(64), "read");
    coordinator.beforeDispatch("done");
    coordinator.afterDispatch("done");
    coordinator.verifySucceeded("done", []);
    const other = new LedgerCoordinator({
      ledger,
      taskId: "task-2",
      surface: "browser",
    });
    other.begin("other-step", "d".repeat(64), "read");
    other.beforeDispatch("other-step");
    expect(coordinator.recoverPending()).toEqual([]);
    expect(other.recoverPending().map((entry) => entry.actionId)).toEqual([
      "other-step",
    ]);
  });

  it("fails closed on invalid transitions and malformed entries", () => {
    const coordinator = new LedgerCoordinator({
      ledger,
      taskId: "task-1",
      surface: "browser",
    });
    coordinator.begin("step-1", "a".repeat(64), "read");
    expect(() => coordinator.verifySucceeded("step-1", [])).toThrow(
      /Invalid ledger transition/,
    );
    expect(() =>
      ledger.put({
        schemaVersion: "lhic-side-effect-ledger-v1",
        actionId: "bad",
        actionHash: "short",
        taskId: "task-1",
        surface: "browser",
        sideEffectClass: "read",
        state: "proposed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow(/malformed ledger entry/);
  });
});
