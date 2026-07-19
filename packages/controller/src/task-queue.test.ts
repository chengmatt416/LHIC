import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DistributedTaskQueue } from "./task-queue.js";

describe("DistributedTaskQueue", () => {
  it("enqueues tasks and enforces strict per-account lock exclusion", () => {
    const db = new DatabaseSync(":memory:");
    const queue = new DistributedTaskQueue(db, {
      encryptionSecret: "queue-test-secret",
    });

    queue.enqueue("task-1", "account-A", { step: 1 });
    queue.enqueue("task-2", "account-A", { step: 2 });
    queue.enqueue("task-3", "account-B", { step: 1 });

    const task1 = queue.acquireLockedTask();
    expect(task1).toBeDefined();
    expect(task1?.id).toBe("task-1");
    expect(task1?.accountId).toBe("account-A");
    expect(task1?.status).toBe("running");

    const task3 = queue.acquireLockedTask();
    expect(task3).toBeDefined();
    expect(task3?.id).toBe("task-3");
    expect(task3?.accountId).toBe("account-B");

    const noTask = queue.acquireLockedTask();
    expect(noTask).toBeUndefined();

    queue.completeTask("task-1", "completed", task1!.leaseId);

    const task2 = queue.acquireLockedTask();
    expect(task2).toBeDefined();
    expect(task2?.id).toBe("task-2");
    expect(task2?.accountId).toBe("account-A");
  });

  it("recovers expired leases and rejects stale workers", () => {
    const db = new DatabaseSync(":memory:");
    const queue = new DistributedTaskQueue(db, {
      encryptionSecret: "queue-test-secret",
    });
    const start = new Date("2026-07-19T00:00:00.000Z");

    queue.enqueue("task-1", "account-A", { step: 1 });
    const first = queue.acquireLockedTask({
      now: start,
      leaseDurationMs: 1_000,
      leaseId: "lease-a",
    });
    expect(first).toMatchObject({
      id: "task-1",
      leaseId: "lease-a",
      leaseExpiresAt: "2026-07-19T00:00:01.000Z",
    });
    expect(
      queue.acquireLockedTask({
        now: new Date("2026-07-19T00:00:00.500Z"),
        leaseId: "lease-before-expiry",
      }),
    ).toBeUndefined();

    const recovered = queue.acquireLockedTask({
      now: new Date("2026-07-19T00:00:01.001Z"),
      leaseDurationMs: 2_000,
      leaseId: "lease-b",
    });
    expect(recovered).toMatchObject({
      id: "task-1",
      leaseId: "lease-b",
      status: "running",
    });
    expect(() =>
      queue.completeTask("task-1", "completed", first!.leaseId),
    ).toThrow("no longer valid");
    expect(() => queue.renewTaskLease("task-1", first!.leaseId)).toThrow(
      "no longer valid",
    );
    expect(() =>
      queue.renewTaskLease("task-1", recovered!.leaseId),
    ).not.toThrow();
    expect(() =>
      queue.completeTask("task-1", "completed", recovered!.leaseId),
    ).not.toThrow();
  });

  it("migrates an existing queue table without losing queued work", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE queued_tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO queued_tasks
       (id, account_id, payload_json, status, created_at)
       VALUES (?, ?, ?, 'queued', ?)`,
    ).run("legacy-task", "account-A", "{}", "2026-07-19T00:00:00.000Z");

    const queue = new DistributedTaskQueue(db, {
      encryptionSecret: "queue-test-secret",
    });
    const task = queue.acquireLockedTask({ leaseId: "migrated-lease" });
    expect(task).toMatchObject({
      id: "legacy-task",
      leaseId: "migrated-lease",
    });
    expect(
      (
        db
          .prepare("SELECT payload_json FROM queued_tasks WHERE id = ?")
          .get("legacy-task") as { payload_json: string }
      ).payload_json,
    ).toMatch(/^v1:/);
  });

  it("requeues legacy running work that has no lease owner", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE queued_tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
    `);
    db.prepare(
      `INSERT INTO queued_tasks
       (id, account_id, payload_json, status, created_at, started_at)
       VALUES (?, ?, ?, 'running', ?, ?)`,
    ).run(
      "legacy-running",
      "account-A",
      "{}",
      "2026-07-19T00:00:00.000Z",
      "2026-07-19T00:01:00.000Z",
    );

    const queue = new DistributedTaskQueue(db, {
      encryptionSecret: "queue-test-secret",
    });
    expect(
      queue.acquireLockedTask({ leaseId: "recovered-lease" }),
    ).toMatchObject({
      id: "legacy-running",
      leaseId: "recovered-lease",
    });
  });

  it("requires the encryption secret and never stores a clear payload", () => {
    const db = new DatabaseSync(":memory:");
    expect(
      () => new DistributedTaskQueue(db, { encryptionSecret: " " }),
    ).toThrow("encryption secret");
    const queue = new DistributedTaskQueue(db, {
      encryptionSecret: "correct-queue-secret",
    });
    queue.enqueue("secret-task", "account-A", { token: "do-not-store" });
    const raw = db
      .prepare("SELECT payload_json FROM queued_tasks WHERE id = ?")
      .get("secret-task") as { payload_json: string };
    expect(raw.payload_json).not.toContain("do-not-store");
    expect(() =>
      new DistributedTaskQueue(db, {
        encryptionSecret: "wrong-queue-secret",
      }).acquireLockedTask(),
    ).toThrow();
  });
});
