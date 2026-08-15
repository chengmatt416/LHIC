import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One SQLite database for durable execution state (side-effect ledger +
 * workspace read sets/conflicts + approval scope usage). Strict tables,
 * WAL journaling, and synchronous commits so security-critical state
 * transitions are crash-safe.
 */
export function createLedgerDatabase(databaseFile: string): DatabaseSync {
  mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databaseFile);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = FULL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS side_effect_ledger (
      action_id TEXT PRIMARY KEY,
      action_hash TEXT NOT NULL,
      task_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      side_effect_class TEXT NOT NULL,
      state TEXT NOT NULL,
      approval_expires_at TEXT,
      idempotency_key TEXT,
      precondition_evidence TEXT NOT NULL DEFAULT '[]',
      verifier_evidence TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspace_read_sets (
      agent_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, task_id, path)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspace_conflicts (
      conflict_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      path TEXT NOT NULL,
      old_hash TEXT NOT NULL,
      new_hash TEXT NOT NULL,
      affected_agent_id TEXT NOT NULL,
      writer_agent_id TEXT,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      acknowledged_by TEXT,
      acknowledged_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS workspace_conflicts_task
      ON workspace_conflicts (task_id, path);
    CREATE TABLE IF NOT EXISTS approval_scope_usage (
      approval_id TEXT PRIMARY KEY,
      actions_used INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
  // Migration: conflict tables created before the affected-agent column
  // gain it now (old rows have NULL = unknown recipient, fail closed).
  const conflictColumns = database
    .prepare("PRAGMA table_info(workspace_conflicts)")
    .all() as Array<{ name: string }>;
  if (
    conflictColumns.length > 0 &&
    !conflictColumns.some((column) => column.name === "affected_agent_id")
  ) {
    database.exec(
      "ALTER TABLE workspace_conflicts ADD COLUMN affected_agent_id TEXT;",
    );
  }
  return database;
}

export function jsonArray(value: string[]): string {
  return JSON.stringify(value);
}

export function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
