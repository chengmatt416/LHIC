import type { DatabaseSync } from "node:sqlite";

export interface QueuedTask {
  id: string;
  accountId: string;
  payloadJson: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export class DistributedTaskQueue {
  public constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS queued_tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      ) STRICT;
    `);
  }

  /**
   * Enqueues a new automation task for a specific account.
   */
  public enqueue(
    id: string,
    accountId: string,
    payload: Record<string, unknown>,
  ): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO queued_tasks (id, account_id, payload_json, status, created_at)
        VALUES (?, ?, ?, 'queued', ?)
      `,
      )
      .run(id, accountId, JSON.stringify(payload), now);
  }

  /**
   * Acquires a task to execute, enforcing a strict distributed lock per accountId.
   */
  public acquireLockedTask(): QueuedTask | undefined {
    const row = this.database
      .prepare(
        `
        SELECT * FROM queued_tasks
        WHERE status = 'queued'
          AND account_id NOT IN (
            SELECT DISTINCT account_id FROM queued_tasks WHERE status = 'running'
          )
        ORDER BY created_at ASC
        LIMIT 1
      `,
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }

    const startedAt = new Date().toISOString();
    this.database
      .prepare(
        `
        UPDATE queued_tasks
        SET status = 'running', started_at = ?
        WHERE id = ?
      `,
      )
      .run(startedAt, row.id as string);

    const task: QueuedTask = {
      id: row.id as string,
      accountId: row.account_id as string,
      payloadJson: row.payload_json as string,
      status: "running",
      createdAt: row.created_at as string,
      startedAt,
    };
    if (row.completed_at) {
      task.completedAt = row.completed_at as string;
    }
    return task;
  }

  /**
   * Completes the task and releases the account lock.
   */
  public completeTask(id: string, status: "completed" | "failed"): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        UPDATE queued_tasks
        SET status = ?, completed_at = ?
        WHERE id = ?
      `,
      )
      .run(status, now, id);
  }
}
