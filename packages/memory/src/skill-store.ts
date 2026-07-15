import { DatabaseSync } from "node:sqlite";

import type { VerificationResult } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

export type SkillLifecycle = "draft" | "verified" | "habit" | "trusted";

export interface SkillRecord {
  name: string;
  definition: Record<string, unknown>;
  lifecycle: SkillLifecycle;
  successCount: number;
  failureCount: number;
  lastSuccessAt?: string;
}

interface SkillRow {
  name: string;
  definition_json: string;
  lifecycle: SkillLifecycle;
  success_count: number;
  failure_count: number;
  last_success_at: string | null;
}

export function createMemoryDatabase(filePath = ":memory:"): DatabaseSync {
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_success_at TEXT
    ) STRICT;
  `);
  return database;
}

function nextLifecycle(
  current: SkillLifecycle,
  successCount: number,
): SkillLifecycle {
  if (current === "draft") {
    return "verified";
  }
  if (current === "verified" && successCount >= 3) {
    return "habit";
  }
  if (current === "habit" && successCount >= 10) {
    return "trusted";
  }
  return current;
}

export class SkillStore {
  public constructor(private readonly database: DatabaseSync) {
    createSkillsTable(database);
  }

  public get(name: string): SkillRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM skills WHERE name = ?")
      .get(name) as SkillRow | undefined;
    return row ? mapSkillRow(row) : undefined;
  }

  public recordVerifiedSuccess(
    name: string,
    definition: Record<string, unknown>,
    verification: VerificationResult,
  ): SkillRecord {
    if (!verification.success || verification.evidence.length === 0) {
      throw new Error(
        "Skills can only be promoted with successful verifier evidence.",
      );
    }
    const existing = this.get(name);
    const successCount = (existing?.successCount ?? 0) + 1;
    const lifecycle = nextLifecycle(
      existing?.lifecycle ?? "draft",
      successCount,
    );
    const safeDefinition = JSON.stringify(redactPII(definition));
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO skills (name, definition_json, lifecycle, success_count, failure_count, last_success_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          definition_json = excluded.definition_json,
          lifecycle = excluded.lifecycle,
          success_count = excluded.success_count,
          last_success_at = excluded.last_success_at
      `,
      )
      .run(
        name,
        safeDefinition,
        lifecycle,
        successCount,
        existing?.failureCount ?? 0,
        now,
      );
    return this.get(name) as SkillRecord;
  }

  public recordFailure(name: string): SkillRecord | undefined {
    this.database
      .prepare(
        "UPDATE skills SET failure_count = failure_count + 1 WHERE name = ?",
      )
      .run(name);
    return this.get(name);
  }
}

function createSkillsTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      name TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_success_at TEXT
    ) STRICT;
  `);
}

function mapSkillRow(row: SkillRow): SkillRecord {
  return {
    name: row.name,
    definition: JSON.parse(row.definition_json) as Record<string, unknown>,
    lifecycle: row.lifecycle,
    successCount: row.success_count,
    failureCount: row.failure_count,
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
  };
}
