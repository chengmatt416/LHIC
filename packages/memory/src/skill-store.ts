import { DatabaseSync } from "node:sqlite";

import type { VerificationResult } from "@lhic/schema";
import { hashState, redactPII } from "@lhic/trace";

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
  definitionSha256: string;
  verifiedRunCount: number;
  holdoutPassed: boolean;
  promoted: boolean;
}

export type CandidateRunSource =
  "slow_path" | "mcp_batch" | "public_web" | "interactive_demo";

export type CandidateRunEnvironment =
  | "production"
  | "public_read_only"
  | "allowlisted_sandbox"
  | "registered_test_account";

export type CandidateHoldoutEnvironment =
  "local_fixture" | "allowlisted_sandbox" | "registered_test_account";

/**
 * Redacted, tamper-evident metadata required for every candidate execution.
 * The hashes are stored instead of raw traces or DOM snapshots.
 */
export interface CandidateRunProvenance {
  source: CandidateRunSource;
  environment: CandidateRunEnvironment;
  origin: string;
  uiFingerprint: string;
  traceSha256: string;
  verifierVersion: string;
}

/** Evidence emitted only by the offline evaluator after a separate holdout. */
export interface CandidateHoldoutProvenance {
  evaluator: "offline-evaluation-v1";
  environment: CandidateHoldoutEnvironment;
  evaluationId: string;
  origin: string;
  uiFingerprint: string;
  verifierVersion: string;
  candidateDefinitionSha256: string;
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
  definition_sha256: string;
  verified_run_count: number;
  holdout_passed: number;
  promoted_at: string | null;
}

interface CandidateHoldoutRow {
  candidate_name: string;
  evaluator: string;
  environment: string;
  evaluation_id: string;
  origin: string;
  ui_fingerprint: string;
  verifier_version: string;
  candidate_definition_sha256: string;
  evidence_sha256: string;
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
    provenance: CandidateRunProvenance,
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
    const definitionSha256 = hashState(JSON.parse(safeDefinition) as unknown);
    assertCandidateRunProvenance(provenance);
    const existing = this.getCandidate(name);
    if (
      existing?.definitionSha256 &&
      existing.definitionSha256 !== definitionSha256
    ) {
      throw new Error(
        "Candidate Skill definition changed; record it under a new candidate name.",
      );
    }
    const evidenceSha256 = hashState(verification.evidence);
    this.database
      .prepare(
        `
        INSERT INTO candidate_skills (
          name, definition_json, definition_sha256, verified_run_count, holdout_passed, promoted_at
        ) VALUES (?, ?, ?, 0, 0, NULL)
        ON CONFLICT(name) DO UPDATE SET
          definition_json = excluded.definition_json,
          definition_sha256 = excluded.definition_sha256
      `,
      )
      .run(name, safeDefinition, definitionSha256);
    this.database
      .prepare(
        `
        INSERT INTO candidate_skill_runs (
          candidate_name, task_id, source, environment, origin, ui_fingerprint,
          trace_sha256, verifier_version, evidence_sha256, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_name, task_id) DO NOTHING
      `,
      )
      .run(
        name,
        taskId,
        provenance.source,
        provenance.environment,
        provenance.origin,
        provenance.uiFingerprint,
        provenance.traceSha256,
        provenance.verifierVersion,
        evidenceSha256,
        new Date().toISOString(),
      );
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

  /**
   * Records a separately evaluated holdout. Promotion rejects a holdout that
   * reuses a candidate run's UI fingerprint or targets a different definition.
   */
  public recordCandidateHoldout(
    name: string,
    verification: VerificationResult,
    provenance: CandidateHoldoutProvenance,
  ): CandidateSkillRecord {
    if (!verification.success || verification.evidence.length === 0) {
      throw new Error(
        "Candidate holdout promotion requires successful verifier evidence.",
      );
    }
    assertCandidateHoldoutProvenance(provenance);
    const candidate = this.getCandidate(name);
    if (!candidate) {
      throw new Error("Candidate skill does not exist.");
    }
    if (candidate.definitionSha256 !== provenance.candidateDefinitionSha256) {
      throw new Error(
        "Candidate holdout does not match the candidate Skill definition.",
      );
    }
    const matchingRun = this.database
      .prepare(
        `
        SELECT 1 FROM candidate_skill_runs
        WHERE candidate_name = ? AND ui_fingerprint = ?
        LIMIT 1
      `,
      )
      .get(name, provenance.uiFingerprint);
    if (matchingRun) {
      throw new Error(
        "Candidate holdout must use a UI fingerprint not seen during training.",
      );
    }
    const matchingTask = this.database
      .prepare(
        `
        SELECT 1 FROM candidate_skill_runs
        WHERE candidate_name = ? AND task_id = ?
        LIMIT 1
      `,
      )
      .get(name, provenance.evaluationId);
    if (matchingTask) {
      throw new Error(
        "Candidate holdout must use a separate evaluation identifier.",
      );
    }
    const evidenceSha256 = hashState(verification.evidence);
    this.database
      .prepare(
        `
        INSERT INTO candidate_skill_holdouts (
          candidate_name, evaluator, environment, evaluation_id, origin,
          ui_fingerprint, verifier_version, candidate_definition_sha256,
          evidence_sha256, verified_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(candidate_name) DO UPDATE SET
          evaluator = excluded.evaluator,
          environment = excluded.environment,
          evaluation_id = excluded.evaluation_id,
          origin = excluded.origin,
          ui_fingerprint = excluded.ui_fingerprint,
          verifier_version = excluded.verifier_version,
          candidate_definition_sha256 = excluded.candidate_definition_sha256,
          evidence_sha256 = excluded.evidence_sha256,
          verified_at = excluded.verified_at
      `,
      )
      .run(
        name,
        provenance.evaluator,
        provenance.environment,
        provenance.evaluationId,
        provenance.origin,
        provenance.uiFingerprint,
        provenance.verifierVersion,
        provenance.candidateDefinitionSha256,
        evidenceSha256,
        new Date().toISOString(),
      );
    this.database
      .prepare("UPDATE candidate_skills SET holdout_passed = 1 WHERE name = ?")
      .run(name);
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
    if (!this.hasPromotionEvidence(candidate)) {
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

  private hasPromotionEvidence(candidate: CandidateSkillRecord): boolean {
    if (
      candidate.verifiedRunCount < 3 ||
      !candidate.holdoutPassed ||
      !isSha256(candidate.definitionSha256)
    ) {
      return false;
    }
    const run = this.database
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM candidate_skill_runs
        WHERE candidate_name = ?
          AND source != 'interactive_demo'
          AND environment IN (
            'production', 'public_read_only', 'allowlisted_sandbox',
            'registered_test_account'
          )
          AND origin != 'https://unknown.invalid'
          AND length(ui_fingerprint) = 64
          AND length(trace_sha256) = 64
          AND verifier_version != ''
      `,
      )
      .get(candidate.name) as { count: number };
    if (run.count < 3) return false;
    const holdout = this.database
      .prepare(
        `
        SELECT * FROM candidate_skill_holdouts
        WHERE candidate_name = ?
          AND evaluator = 'offline-evaluation-v1'
          AND environment IN (
            'local_fixture', 'allowlisted_sandbox', 'registered_test_account'
          )
          AND candidate_definition_sha256 = ?
          AND length(ui_fingerprint) = 64
          AND verifier_version != ''
        LIMIT 1
      `,
      )
      .get(candidate.name, candidate.definitionSha256) as
      CandidateHoldoutRow | undefined;
    return holdout !== undefined;
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
      definition_sha256 TEXT NOT NULL DEFAULT '',
      verified_run_count INTEGER NOT NULL DEFAULT 0,
      holdout_passed INTEGER NOT NULL DEFAULT 0,
      promoted_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS candidate_skill_runs (
      candidate_name TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      environment TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT '',
      ui_fingerprint TEXT NOT NULL DEFAULT '',
      trace_sha256 TEXT NOT NULL DEFAULT '',
      verifier_version TEXT NOT NULL DEFAULT '',
      evidence_sha256 TEXT NOT NULL DEFAULT '',
      verified_at TEXT NOT NULL,
      PRIMARY KEY (candidate_name, task_id),
      FOREIGN KEY (candidate_name) REFERENCES candidate_skills(name)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS candidate_skill_holdouts (
      candidate_name TEXT PRIMARY KEY,
      evaluator TEXT NOT NULL,
      environment TEXT NOT NULL,
      evaluation_id TEXT NOT NULL,
      origin TEXT NOT NULL,
      ui_fingerprint TEXT NOT NULL,
      verifier_version TEXT NOT NULL,
      candidate_definition_sha256 TEXT NOT NULL,
      evidence_sha256 TEXT NOT NULL,
      verified_at TEXT NOT NULL,
      FOREIGN KEY (candidate_name) REFERENCES candidate_skills(name)
    ) STRICT;
  `);
  ensureColumn(
    database,
    "candidate_skills",
    "definition_sha256",
    "TEXT NOT NULL DEFAULT ''",
  );
  for (const [name, definition] of [
    ["source", "TEXT NOT NULL DEFAULT ''"],
    ["environment", "TEXT NOT NULL DEFAULT ''"],
    ["origin", "TEXT NOT NULL DEFAULT ''"],
    ["ui_fingerprint", "TEXT NOT NULL DEFAULT ''"],
    ["trace_sha256", "TEXT NOT NULL DEFAULT ''"],
    ["verifier_version", "TEXT NOT NULL DEFAULT ''"],
    ["evidence_sha256", "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    ensureColumn(database, "candidate_skill_runs", name, definition);
  }
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS candidate_skill_runs_trace_identity
      ON candidate_skill_runs(candidate_name, trace_sha256)
      WHERE trace_sha256 != '';
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
    definitionSha256: row.definition_sha256,
    verifiedRunCount: row.verified_run_count,
    holdoutPassed: row.holdout_passed === 1,
    promoted: row.promoted_at !== null,
  };
}

function ensureColumn(
  database: DatabaseSync,
  table: "candidate_skills" | "candidate_skill_runs",
  name: string,
  definition: string,
): void {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function assertCandidateRunProvenance(
  provenance: CandidateRunProvenance,
): void {
  if (
    !["slow_path", "mcp_batch", "public_web", "interactive_demo"].includes(
      provenance.source,
    ) ||
    ![
      "production",
      "public_read_only",
      "allowlisted_sandbox",
      "registered_test_account",
    ].includes(provenance.environment) ||
    !isOrigin(provenance.origin) ||
    !isSha256(provenance.uiFingerprint) ||
    !isSha256(provenance.traceSha256) ||
    !isLimitedString(provenance.verifierVersion, 128)
  ) {
    throw new Error("Candidate Skill provenance is invalid.");
  }
}

function assertCandidateHoldoutProvenance(
  provenance: CandidateHoldoutProvenance,
): void {
  if (
    provenance.evaluator !== "offline-evaluation-v1" ||
    ![
      "local_fixture",
      "allowlisted_sandbox",
      "registered_test_account",
    ].includes(provenance.environment) ||
    !isLimitedString(provenance.evaluationId, 256) ||
    !isOrigin(provenance.origin) ||
    !isSha256(provenance.uiFingerprint) ||
    !isLimitedString(provenance.verifierVersion, 128) ||
    !isSha256(provenance.candidateDefinitionSha256)
  ) {
    throw new Error("Candidate Skill holdout provenance is invalid.");
  }
}

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

function isLimitedString(value: string, maximum: number): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}
