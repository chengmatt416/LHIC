import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DistributedTaskQueue } from "./task-queue.js";

describe("DistributedTaskQueue", () => {
  it("enqueues tasks and enforces strict per-account lock exclusion", () => {
    const db = new DatabaseSync(":memory:");
    const queue = new DistributedTaskQueue(db);

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

    queue.completeTask("task-1", "completed");

    const task2 = queue.acquireLockedTask();
    expect(task2).toBeDefined();
    expect(task2?.id).toBe("task-2");
    expect(task2?.accountId).toBe("account-A");
  });
});
