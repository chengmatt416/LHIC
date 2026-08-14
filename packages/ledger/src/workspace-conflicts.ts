import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import { createLedgerDatabase } from "./ledger-database.js";

export interface WorkspaceReadSet {
  agentId: string;
  taskId: string;
  path: string;
  contentHash: string;
  updatedAt: string;
}

export interface WorkspaceConflict {
  conflictId: string;
  taskId: string;
  path: string;
  oldHash: string;
  newHash: string;
  /** The agent whose read is now stale; the notification recipient. */
  affectedAgentId: string;
  writerAgentId?: string;
  summary: string;
  createdAt: string;
  acknowledgedBy?: string;
  acknowledgedAt?: string;
}

export interface WorkspaceConflictStoreOptions {
  databaseFile: string;
}

/**
 * Same-repository stale-read awareness. Read sets record only observable
 * reads; a file change notifies every active agent that read the old hash.
 * A stale agent's write is gated until it re-reads or explicitly
 * acknowledges the conflict. State persists across OMP restarts (task-scoped).
 */
export class WorkspaceConflictStore {
  private readonly database: DatabaseSync;
  private closed = false;

  public constructor(options: WorkspaceConflictStoreOptions) {
    this.database = createLedgerDatabase(options.databaseFile);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  public recordRead(
    agentId: string,
    taskId: string,
    path: string,
    contentHash: string,
    at = new Date().toISOString(),
  ): void {
    this.database
      .prepare(
        `INSERT INTO workspace_read_sets (agent_id, task_id, path, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, task_id, path) DO UPDATE SET
           content_hash = excluded.content_hash, updated_at = excluded.updated_at`,
      )
      .run(agentId, taskId, path, contentHash, at);
  }

  public readSet(
    agentId: string,
    taskId: string,
    path: string,
  ): WorkspaceReadSet | undefined {
    const row = this.database
      .prepare(
        `SELECT agent_id, task_id, path, content_hash, updated_at
         FROM workspace_read_sets WHERE agent_id = ? AND task_id = ? AND path = ?`,
      )
      .get(agentId, taskId, path) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      agentId: String(row.agent_id),
      taskId: String(row.task_id),
      path: String(row.path),
      contentHash: String(row.content_hash),
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Records a file change and returns the conflicts created: every active
   * agent whose read set holds the old hash (and did not write the change)
   * is notified. A change back to the old hash clears pending conflicts.
   */
  public onFileChanged(
    taskId: string,
    path: string,
    newHash: string,
    options: { writerAgentId?: string; summary?: string } = {},
  ): WorkspaceConflict[] {
    const now = new Date().toISOString();
    const readers = this.database
      .prepare(
        `SELECT agent_id, content_hash FROM workspace_read_sets
         WHERE task_id = ? AND path = ?`,
      )
      .all(taskId, path) as Array<{ agent_id: string; content_hash: string }>;
    const conflicts: WorkspaceConflict[] = [];
    for (const reader of readers) {
      if (reader.agent_id === options.writerAgentId) continue;
      if (reader.content_hash === newHash) continue;
      const conflict: WorkspaceConflict = {
        conflictId: randomUUID(),
        taskId,
        path,
        oldHash: reader.content_hash,
        newHash,
        affectedAgentId: reader.agent_id,
        ...(options.writerAgentId
          ? { writerAgentId: options.writerAgentId }
          : {}),
        summary:
          options.summary ?? `File ${path} changed after this agent read it.`,
        createdAt: now,
      };
      this.database
        .prepare(
          `INSERT INTO workspace_conflicts
            (conflict_id, task_id, path, old_hash, new_hash, affected_agent_id,
             writer_agent_id, summary, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conflict.conflictId,
          taskId,
          path,
          conflict.oldHash,
          conflict.newHash,
          conflict.affectedAgentId,
          options.writerAgentId ?? null,
          conflict.summary,
          now,
        );
      conflicts.push(conflict);
    }
    return conflicts;
  }

  /**
   * Write gate: before a stale agent writes `path`, it must have re-read the
   * current hash or explicitly acknowledged every outstanding conflict for
   * that path. Returns the blocking conflict, if any.
   */
  public pendingConflictForWrite(
    agentId: string,
    taskId: string,
    path: string,
  ): WorkspaceConflict | undefined {
    const row = this.database
      .prepare(
        `SELECT conflict_id, task_id, path, old_hash, new_hash, affected_agent_id,
                writer_agent_id, summary, created_at, acknowledged_by, acknowledged_at
         FROM workspace_conflicts
         WHERE task_id = ? AND path = ? AND affected_agent_id = ?
           AND acknowledged_by IS NULL
         ORDER BY created_at LIMIT 1`,
      )
      .get(taskId, path, agentId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const readSet = this.readSet(agentId, taskId, path);
    if (readSet && readSet.contentHash === String(row.new_hash)) {
      return undefined; // Re-read after the conflict: write is safe.
    }
    return this.rowToConflict(row);
  }

  /** Explicit acknowledgment: the agent handles the conflict knowingly. */
  public acknowledgeConflict(
    conflictId: string,
    agentId: string,
    at = new Date().toISOString(),
  ): void {
    this.database
      .prepare(
        `UPDATE workspace_conflicts
         SET acknowledged_by = ?, acknowledged_at = ? WHERE conflict_id = ?`,
      )
      .run(agentId, at, conflictId);
  }

  public conflictsForTask(taskId: string): WorkspaceConflict[] {
    const rows = this.database
      .prepare(
        `SELECT conflict_id, task_id, path, old_hash, new_hash, affected_agent_id,
                writer_agent_id, summary, created_at, acknowledged_by, acknowledged_at
         FROM workspace_conflicts WHERE task_id = ? ORDER BY created_at`,
      )
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToConflict(row));
  }

  /** Unacknowledged conflicts for one agent (the notification recipient). */
  public conflictsForAgent(
    agentId: string,
    taskId: string,
  ): WorkspaceConflict[] {
    const rows = this.database
      .prepare(
        `SELECT conflict_id, task_id, path, old_hash, new_hash, affected_agent_id,
                writer_agent_id, summary, created_at, acknowledged_by, acknowledged_at
         FROM workspace_conflicts
         WHERE task_id = ? AND affected_agent_id = ? AND acknowledged_by IS NULL
         ORDER BY created_at`,
      )
      .all(taskId, agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToConflict(row));
  }

  public removeReadSet(agentId: string, taskId: string): void {
    this.database
      .prepare(
        `DELETE FROM workspace_read_sets WHERE agent_id = ? AND task_id = ?`,
      )
      .run(agentId, taskId);
  }

  private rowToConflict(row: Record<string, unknown>): WorkspaceConflict {
    return {
      conflictId: String(row.conflict_id),
      taskId: String(row.task_id),
      path: String(row.path),
      oldHash: String(row.old_hash),
      newHash: String(row.new_hash),
      affectedAgentId: String(row.affected_agent_id),
      ...(row.writer_agent_id
        ? { writerAgentId: String(row.writer_agent_id) }
        : {}),
      summary: String(row.summary),
      createdAt: String(row.created_at),
      ...(row.acknowledged_by
        ? { acknowledgedBy: String(row.acknowledged_by) }
        : {}),
      ...(row.acknowledged_at
        ? { acknowledgedAt: String(row.acknowledged_at) }
        : {}),
    };
  }
}
