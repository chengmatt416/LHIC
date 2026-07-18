import type { DatabaseSync } from "node:sqlite";

import { redactPII } from "@lhic/trace";

import type { TaskSummary } from "./task-summary.js";

export interface TaskSummaryPersistence {
  save(taskId: string, summary: TaskSummary): void;
  get(taskId: string): TaskSummary | undefined;
}

/**
 * Stores only compact, redacted task summaries. Raw prompts, screenshots,
 * browser storage, and trace payloads intentionally have no column here.
 */
export class DurableTaskSummaryStore implements TaskSummaryPersistence {
  public constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS task_summaries (
        task_id TEXT PRIMARY KEY,
        summary_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  public save(taskId: string, summary: TaskSummary): void {
    if (!taskId.trim()) {
      throw new Error("Task summaries require a non-empty task ID.");
    }
    const safeSummary = redactPII(summary) as TaskSummary;
    this.database
      .prepare(
        `
          INSERT INTO task_summaries (task_id, summary_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            summary_json = excluded.summary_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(taskId, JSON.stringify(safeSummary), new Date().toISOString());
  }

  public get(taskId: string): TaskSummary | undefined {
    const row = this.database
      .prepare("SELECT summary_json FROM task_summaries WHERE task_id = ?")
      .get(taskId) as { summary_json?: unknown } | undefined;
    if (!row || typeof row.summary_json !== "string") {
      return undefined;
    }
    return JSON.parse(row.summary_json) as TaskSummary;
  }
}
