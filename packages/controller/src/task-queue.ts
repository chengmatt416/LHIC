import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { decryptText, encryptText } from "@lhic/security";

export interface QueuedTask {
  id: string;
  accountId: string;
  payloadJson: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  leaseId: string;
  leaseExpiresAt: string;
}

export interface TaskLeaseOptions {
  now?: Date;
  leaseDurationMs?: number;
  leaseId?: string;
}

export interface DistributedTaskQueueOptions {
  encryptionSecret: string;
}

const defaultLeaseDurationMs = 60_000;
const maxLeaseDurationMs = 24 * 60 * 60 * 1_000;

export class DistributedTaskQueue {
  private readonly encryptionSecret: string;

  public constructor(
    private readonly database: DatabaseSync,
    options: DistributedTaskQueueOptions,
  ) {
    if (!options.encryptionSecret.trim()) {
      throw new Error("Task queue storage requires an encryption secret.");
    }
    this.encryptionSecret = options.encryptionSecret;
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS queued_tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        lease_id TEXT,
        lease_expires_at TEXT
      ) STRICT;
    `);
    this.migrateLeaseColumns();
    this.migratePayloads();
    this.database.exec("PRAGMA busy_timeout = 5000;");
  }

  /**
   * Enqueues a new automation task for a specific account.
   */
  public enqueue(
    id: string,
    accountId: string,
    payload: Record<string, unknown>,
  ): void {
    if (!id.trim() || !accountId.trim()) {
      throw new Error("Queued tasks require an id and account id.");
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO queued_tasks (
          id, account_id, payload_json, status, created_at, lease_id, lease_expires_at
        )
        VALUES (?, ?, ?, 'queued', ?, NULL, NULL)
      `,
      )
      .run(
        id,
        accountId,
        encryptText(JSON.stringify(payload), this.encryptionSecret),
        now,
      );
  }

  /**
   * Acquires one task atomically. Expired leases are eligible for recovery,
   * while an unexpired lease continues to block other work for the account.
   */
  public acquireLockedTask(
    options: TaskLeaseOptions = {},
  ): QueuedTask | undefined {
    const now = options.now ?? new Date();
    const leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
    validateLeaseDuration(leaseDurationMs);
    const nowIso = now.toISOString();
    const leaseExpiresAt = new Date(
      now.getTime() + leaseDurationMs,
    ).toISOString();
    const leaseId = options.leaseId ?? randomUUID();
    if (!leaseId.trim()) {
      throw new Error("Task leases require a non-empty lease id.");
    }

    const row = this.database
      .prepare(
        `
        WITH candidate AS (
          SELECT task.id
          FROM queued_tasks AS task
          WHERE (
            task.status = 'queued'
            OR (
              task.status = 'running'
              AND task.lease_expires_at IS NOT NULL
              AND task.lease_expires_at <= ?
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM queued_tasks AS active
            WHERE active.account_id = task.account_id
              AND active.status = 'running'
              AND (
                active.lease_expires_at IS NULL
                OR active.lease_expires_at > ?
              )
          )
          ORDER BY task.created_at ASC, task.id ASC
          LIMIT 1
        )
        UPDATE queued_tasks
        SET
          status = 'running',
          started_at = ?,
          completed_at = NULL,
          lease_id = ?,
          lease_expires_at = ?
        WHERE id = (SELECT id FROM candidate)
        RETURNING *
      `,
      )
      .get(nowIso, nowIso, nowIso, leaseId, leaseExpiresAt) as
      Record<string, unknown> | undefined;

    return row ? toQueuedTask(row, this.encryptionSecret) : undefined;
  }

  /**
   * Extends a task lease only when the caller still owns the current lease.
   */
  public renewTaskLease(
    id: string,
    leaseId: string,
    options: Omit<TaskLeaseOptions, "leaseId"> = {},
  ): string {
    if (!leaseId.trim()) {
      throw new Error("Task lease renewal requires a lease id.");
    }
    const now = options.now ?? new Date();
    const leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
    validateLeaseDuration(leaseDurationMs);
    const expiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const result = this.database
      .prepare(
        `
        UPDATE queued_tasks
        SET lease_expires_at = ?
        WHERE id = ? AND status = 'running' AND lease_id = ?
      `,
      )
      .run(expiresAt, id, leaseId);
    if (result.changes !== 1) {
      throw new Error("Task lease is missing or no longer valid.");
    }
    return expiresAt;
  }

  /**
   * Completes the task and releases the account lock. A lease id is required
   * for tasks acquired by the current queue implementation, preventing a
   * stale worker from completing a task after it has been reassigned.
   */
  public completeTask(
    id: string,
    status: "completed" | "failed",
    leaseId?: string,
  ): void {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `
        UPDATE queued_tasks
        SET
          status = ?,
          completed_at = ?,
          lease_id = NULL,
          lease_expires_at = NULL
        WHERE id = ?
          AND status = 'running'
          AND (
            lease_id = ?
            OR (lease_id IS NULL AND ? IS NULL)
          )
      `,
      )
      .run(status, now, id, leaseId ?? null, leaseId ?? null);
    if (result.changes !== 1) {
      throw new Error("Task lease is missing or no longer valid.");
    }
  }

  private migrateLeaseColumns(): void {
    const columns = this.database
      .prepare("PRAGMA table_info(queued_tasks)")
      .all() as Array<{ name?: unknown }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("lease_id")) {
      this.database.exec("ALTER TABLE queued_tasks ADD COLUMN lease_id TEXT");
    }
    if (!names.has("lease_expires_at")) {
      this.database.exec(
        "ALTER TABLE queued_tasks ADD COLUMN lease_expires_at TEXT",
      );
    }
    // The pre-lease schema could leave a task marked running after a worker
    // process exited. Without ownership metadata it cannot be completed safely,
    // so make it eligible for a fresh lease instead of blocking the account.
    this.database
      .prepare(
        `UPDATE queued_tasks
         SET status = 'queued', started_at = NULL, completed_at = NULL
         WHERE status = 'running' AND lease_id IS NULL`,
      )
      .run();
  }

  private migratePayloads(): void {
    const rows = this.database
      .prepare(
        `SELECT id, payload_json FROM queued_tasks
         WHERE payload_json NOT LIKE 'v1:%'`,
      )
      .all() as Array<{ id?: unknown; payload_json?: unknown }>;
    const update = this.database.prepare(
      "UPDATE queued_tasks SET payload_json = ? WHERE id = ?",
    );
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.payload_json !== "string") {
        throw new Error("Queued task payload migration found an invalid row.");
      }
      try {
        JSON.parse(row.payload_json);
      } catch {
        throw new Error("Queued task payload migration found invalid JSON.");
      }
      update.run(encryptText(row.payload_json, this.encryptionSecret), row.id);
    }
  }
}

function validateLeaseDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maxLeaseDurationMs) {
    throw new Error(
      `Task lease duration must be an integer between 1 and ${maxLeaseDurationMs} milliseconds.`,
    );
  }
}

function toQueuedTask(
  row: Record<string, unknown>,
  encryptionSecret: string,
): QueuedTask {
  if (
    typeof row.id !== "string" ||
    typeof row.account_id !== "string" ||
    typeof row.payload_json !== "string" ||
    typeof row.created_at !== "string" ||
    typeof row.lease_id !== "string" ||
    typeof row.lease_expires_at !== "string"
  ) {
    throw new Error("Queued task row is missing lease metadata.");
  }
  const task: QueuedTask = {
    id: row.id,
    accountId: row.account_id,
    payloadJson: decryptText(row.payload_json, encryptionSecret),
    status: "running",
    createdAt: row.created_at,
    leaseId: row.lease_id,
    leaseExpiresAt: row.lease_expires_at,
  };
  if (typeof row.started_at === "string") {
    task.startedAt = row.started_at;
  }
  if (typeof row.completed_at === "string") {
    task.completedAt = row.completed_at;
  }
  return task;
}
