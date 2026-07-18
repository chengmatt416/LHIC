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

export interface CandidateSkillRecord {
  name: string;
  definition: Record<string, unknown>;
  verifiedRunCount: number;
  holdoutPassed: boolean;
  promoted: boolean;
}

interface SkillRow {
  name: string;
  definition_json: string;
  lifecycle: SkillLifecycle;
  success_count: number;
  failure_count: number;
  last_success_at: string | null;
}

interface CandidateSkillRow {
  name: string;
  definition_json: string;
  verified_run_count: number;
  holdout_passed: number;
  promoted_at: string | null;
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
  createCandidateSkillTables(database);
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
    createCandidateSkillTables(database);
  }

  public get(name: string): SkillRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM skills WHERE name = ?")
      .get(name) as SkillRow | undefined;
    return row ? mapSkillRow(row) : undefined;
  }

  public list(limit = 100): SkillRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error(
        "Skill list limit must be an integer between 1 and 1000.",
      );
    }
    const rows = this.database
      .prepare(
        `
        SELECT * FROM skills
        ORDER BY
          CASE lifecycle
            WHEN 'trusted' THEN 0
            WHEN 'habit' THEN 1
            WHEN 'verified' THEN 2
            ELSE 3
          END,
          success_count DESC,
          name ASC
        LIMIT ?
      `,
      )
      .all(limit) as unknown as SkillRow[];
    return rows.map(mapSkillRow);
  }

  public preload(
    name: string,
    definition: Record<string, unknown>,
  ): SkillRecord {
    if (!name.trim()) {
      throw new Error("Preloaded skill names must not be empty.");
    }
    const existing = this.get(name);
    if (existing) {
      return existing;
    }
    this.database
      .prepare(
        `
        INSERT INTO skills (name, definition_json, lifecycle, success_count, failure_count)
        VALUES (?, ?, 'draft', 0, 0)
      `,
      )
      .run(name, JSON.stringify(redactPII(definition)));
    return this.get(name) as SkillRecord;
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

  /**
   * Records a verified production result as a candidate only. A duplicate
   * taskId never increases the independent-run count.
   */
  public recordCandidateSuccess(
    name: string,
    definition: Record<string, unknown>,
    verification: VerificationResult,
    taskId: string,
  ): CandidateSkillRecord {
    if (!name.trim() || !taskId.trim()) {
      throw new Error(
        "Candidate skills require a name and independent task ID.",
      );
    }
    if (!verification.success || verification.evidence.length === 0) {
      throw new Error("Candidate skills require successful verifier evidence.");
    }
    const safeDefinition = JSON.stringify(redactPII(definition));
    this.database
      .prepare(
        `
        INSERT INTO candidate_skills (
          name, definition_json, verified_run_count, holdout_passed, promoted_at
        ) VALUES (?, ?, 0, 0, NULL)
        ON CONFLICT(name) DO UPDATE SET definition_json = excluded.definition_json
      `,
      )
      .run(name, safeDefinition);
    this.database
      .prepare(
        `
        INSERT INTO candidate_skill_runs (candidate_name, task_id, verified_at)
        VALUES (?, ?, ?)
        ON CONFLICT(candidate_name, task_id) DO NOTHING
      `,
      )
      .run(name, taskId, new Date().toISOString());
    this.database
      .prepare(
        `
        UPDATE candidate_skills
        SET verified_run_count = (
          SELECT COUNT(*) FROM candidate_skill_runs
          WHERE candidate_name = candidate_skills.name
        )
        WHERE name = ?
      `,
      )
      .run(name);
    return this.getCandidate(name) as CandidateSkillRecord;
  }

  public getCandidate(name: string): CandidateSkillRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM candidate_skills WHERE name = ?")
      .get(name) as CandidateSkillRow | undefined;
    return row ? mapCandidateSkillRow(row) : undefined;
  }

  /** Holdout evidence must originate from the offline evaluator. */
  public recordCandidateHoldout(
    name: string,
    verification: VerificationResult,
  ): CandidateSkillRecord {
    if (!verification.success || verification.evidence.length === 0) {
      throw new Error(
        "Candidate holdout promotion requires successful verifier evidence.",
      );
    }
    const updated = this.database
      .prepare("UPDATE candidate_skills SET holdout_passed = 1 WHERE name = ?")
      .run(name);
    if (updated.changes !== 1) {
      throw new Error("Candidate skill does not exist.");
    }
    return this.getCandidate(name) as CandidateSkillRecord;
  }

  /**
   * Makes a candidate eligible for Fast Path only after three independent
   * verifier-backed runs and one holdout pass. Existing learned skills are
   * never replaced by a candidate.
   */
  public promoteCandidate(name: string): SkillRecord | undefined {
    const candidate = this.getCandidate(name);
    if (!candidate) {
      return undefined;
    }
    if (candidate.promoted) {
      return this.get(name);
    }
    if (candidate.verifiedRunCount < 3 || !candidate.holdoutPassed) {
      return undefined;
    }
    const existing = this.get(name);
    if (existing) {
      this.markCandidatePromoted(name);
      return existing;
    }
    const now = new Date().toISOString();
    this.database
      .prepare(
        `
        INSERT INTO skills (
          name, definition_json, lifecycle, success_count, failure_count, last_success_at
        ) VALUES (?, ?, 'habit', 3, 0, ?)
      `,
      )
      .run(name, JSON.stringify(candidate.definition), now);
    this.markCandidatePromoted(name);
    return this.get(name);
  }

  private markCandidatePromoted(name: string): void {
    this.database
      .prepare("UPDATE candidate_skills SET promoted_at = ? WHERE name = ?")
      .run(new Date().toISOString(), name);
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

function createCandidateSkillTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS candidate_skills (
      name TEXT PRIMARY KEY,
      definition_json TEXT NOT NULL,
      verified_run_count INTEGER NOT NULL DEFAULT 0,
      holdout_passed INTEGER NOT NULL DEFAULT 0,
      promoted_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS candidate_skill_runs (
      candidate_name TEXT NOT NULL,
      task_id TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      PRIMARY KEY (candidate_name, task_id),
      FOREIGN KEY (candidate_name) REFERENCES candidate_skills(name)
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

function mapCandidateSkillRow(row: CandidateSkillRow): CandidateSkillRecord {
  return {
    name: row.name,
    definition: JSON.parse(row.definition_json) as Record<string, unknown>,
    verifiedRunCount: row.verified_run_count,
    holdoutPassed: row.holdout_passed === 1,
    promoted: row.promoted_at !== null,
  };
}
