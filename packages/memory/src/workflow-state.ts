import type { DatabaseSync } from "node:sqlite";

import { decryptText, encryptText } from "@lhic/security";

export interface WorkflowState {
  taskId: string;
  workflowName: string;
  lastCompletedStep: number;
  url: string;
  cookiesJson: string;
  localStorageJson: string;
  sessionStorageJson: string;
  updatedAt: string;
}

export interface DurableWorkflowStoreOptions {
  encryptionSecret: string;
}

export class DurableWorkflowStore {
  private readonly encryptionSecret: string;

  public constructor(
    private readonly database: DatabaseSync,
    options: DurableWorkflowStoreOptions,
  ) {
    if (!options.encryptionSecret.trim()) {
      throw new Error(
        "Durable workflow storage requires an encryption secret.",
      );
    }
    this.encryptionSecret = options.encryptionSecret;
    database.exec(`
      CREATE TABLE IF NOT EXISTS workflow_states (
        task_id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        last_completed_step INTEGER NOT NULL,
        url TEXT NOT NULL,
        cookies_json TEXT NOT NULL,
        local_storage_json TEXT NOT NULL,
        session_storage_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  public save(state: Omit<WorkflowState, "updatedAt">): void {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO workflow_states (task_id, workflow_name, last_completed_step, url, cookies_json, local_storage_json, session_storage_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          last_completed_step = excluded.last_completed_step,
          url = excluded.url,
          cookies_json = excluded.cookies_json,
          local_storage_json = excluded.local_storage_json,
          session_storage_json = excluded.session_storage_json,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        state.taskId,
        state.workflowName,
        state.lastCompletedStep,
        encryptText(state.url, this.encryptionSecret),
        encryptText(state.cookiesJson, this.encryptionSecret),
        encryptText(state.localStorageJson, this.encryptionSecret),
        encryptText(state.sessionStorageJson, this.encryptionSecret),
        now,
      );
  }

  public get(taskId: string): WorkflowState | undefined {
    const row = this.database
      .prepare("SELECT * FROM workflow_states WHERE task_id = ?")
      .get(taskId) as Record<string, unknown> | undefined;

    if (!row) {
      return undefined;
    }
    try {
      return {
        taskId: row.task_id as string,
        workflowName: row.workflow_name as string,
        lastCompletedStep: row.last_completed_step as number,
        url: decryptText(row.url as string, this.encryptionSecret),
        cookiesJson: decryptText(
          row.cookies_json as string,
          this.encryptionSecret,
        ),
        localStorageJson: decryptText(
          row.local_storage_json as string,
          this.encryptionSecret,
        ),
        sessionStorageJson: decryptText(
          row.session_storage_json as string,
          this.encryptionSecret,
        ),
        updatedAt: row.updated_at as string,
      };
    } catch {
      throw new Error("Durable workflow state could not be decrypted.");
    }
  }

  public delete(taskId: string): void {
    this.database
      .prepare("DELETE FROM workflow_states WHERE task_id = ?")
      .run(taskId);
  }
}
