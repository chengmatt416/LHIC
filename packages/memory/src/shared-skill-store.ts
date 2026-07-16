import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { redactPII } from "@lhic/trace";

export interface SharedSkillRecord {
  registryId: string;
  skillId: string;
  version: string;
  name: string;
  operationKey: string;
  fingerprint: string;
  definition: Record<string, unknown>;
  fastPathEligible: boolean;
  contentHash: string;
  updatedAt: string;
}

export interface SharedSkillSnapshot {
  skills: SharedSkillRecord[];
  revokedSkillIds: string[];
  cursor?: string;
}

export interface SharedSkillOutboxEntry {
  id: string;
  registryId: string;
  contentHash: string;
  payload: Record<string, unknown>;
  createdAt: string;
  attemptCount: number;
}

export interface SharedSkillSyncState {
  registryId: string;
  lastSuccessAt?: string;
  cursor?: string;
  lastError?: string;
}

interface SharedSkillRow {
  registry_id: string;
  skill_id: string;
  version: string;
  name: string;
  operation_key: string;
  fingerprint: string;
  definition_json: string;
  fast_path_eligible: number;
  content_hash: string;
  updated_at: string;
}

interface SharedSkillOutboxRow {
  id: string;
  registry_id: string;
  content_hash: string;
  payload_json: string;
  created_at: string;
  attempt_count: number;
}

interface SharedSkillSyncStateRow {
  registry_id: string;
  last_success_at: string | null;
  cursor: string | null;
  last_error: string | null;
}

/**
 * Local mirror of approved registry skills. This deliberately remains separate
 * from SkillStore so public records never alter local learning counters.
 */
export class SharedSkillStore {
  public constructor(private readonly database: DatabaseSync) {
    createSharedSkillTables(database);
  }

  public listApproved(registryId: string, limit = 1_000): SharedSkillRecord[] {
    assertRegistryId(registryId);
    assertLimit(limit);
    const rows = this.database
      .prepare(
        `
          SELECT * FROM shared_skills
          WHERE registry_id = ?
          ORDER BY updated_at DESC, skill_id ASC
          LIMIT ?
        `,
      )
      .all(registryId, limit) as unknown as SharedSkillRow[];
    return rows.map(mapSharedSkillRow);
  }

  public findByFingerprint(
    registryId: string,
    operationKey: string,
    fingerprint: string,
  ): SharedSkillRecord[] {
    assertRegistryId(registryId);
    if (!operationKey.trim() || !fingerprint.trim()) {
      return [];
    }
    const rows = this.database
      .prepare(
        `
          SELECT * FROM shared_skills
          WHERE registry_id = ? AND operation_key = ? AND fingerprint = ?
          ORDER BY updated_at DESC, skill_id ASC
        `,
      )
      .all(
        registryId,
        operationKey,
        fingerprint,
      ) as unknown as SharedSkillRow[];
    return rows.map(mapSharedSkillRow);
  }

  public applySnapshot(
    registryId: string,
    snapshot: SharedSkillSnapshot,
  ): void {
    assertRegistryId(registryId);
    const insert = this.database.prepare(
      `
        INSERT INTO shared_skills (
          registry_id, skill_id, version, name, operation_key, fingerprint,
          definition_json, fast_path_eligible, content_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(registry_id, skill_id) DO UPDATE SET
          version = excluded.version,
          name = excluded.name,
          operation_key = excluded.operation_key,
          fingerprint = excluded.fingerprint,
          definition_json = excluded.definition_json,
          fast_path_eligible = excluded.fast_path_eligible,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at
      `,
    );
    const remove = this.database.prepare(
      "DELETE FROM shared_skills WHERE registry_id = ? AND skill_id = ?",
    );

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const skill of snapshot.skills) {
        if (skill.registryId !== registryId) {
          throw new Error("Shared skill snapshot registryId does not match.");
        }
        insert.run(
          registryId,
          skill.skillId,
          skill.version,
          skill.name,
          skill.operationKey,
          skill.fingerprint,
          JSON.stringify(redactPII(skill.definition)),
          skill.fastPathEligible ? 1 : 0,
          skill.contentHash,
          skill.updatedAt,
        );
      }
      for (const skillId of snapshot.revokedSkillIds) {
        if (skillId.trim()) {
          remove.run(registryId, skillId);
        }
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public enqueueSubmission(
    registryId: string,
    contentHash: string,
    payload: Record<string, unknown>,
  ): boolean {
    assertRegistryId(registryId);
    if (!contentHash.trim()) {
      throw new Error("Shared skill submissions require a content hash.");
    }
    const result = this.database
      .prepare(
        `
          INSERT INTO shared_skill_outbox (
            id, registry_id, content_hash, payload_json, created_at, attempt_count
          ) VALUES (?, ?, ?, ?, ?, 0)
          ON CONFLICT(registry_id, content_hash) DO NOTHING
        `,
      )
      .run(
        randomUUID(),
        registryId,
        contentHash,
        JSON.stringify(redactPII(payload)),
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  public listOutbox(registryId: string, limit = 100): SharedSkillOutboxEntry[] {
    assertRegistryId(registryId);
    assertLimit(limit);
    const rows = this.database
      .prepare(
        `
          SELECT * FROM shared_skill_outbox
          WHERE registry_id = ?
          ORDER BY created_at ASC, id ASC
          LIMIT ?
        `,
      )
      .all(registryId, limit) as unknown as SharedSkillOutboxRow[];
    return rows.map(mapOutboxRow);
  }

  public acknowledgeSubmission(id: string): void {
    this.database
      .prepare("DELETE FROM shared_skill_outbox WHERE id = ?")
      .run(id);
  }

  public recordSubmissionFailure(id: string): void {
    this.database
      .prepare(
        `
          UPDATE shared_skill_outbox
          SET attempt_count = attempt_count + 1
          WHERE id = ?
        `,
      )
      .run(id);
  }

  public getSyncState(registryId: string): SharedSkillSyncState {
    assertRegistryId(registryId);
    const row = this.database
      .prepare("SELECT * FROM shared_skill_sync_state WHERE registry_id = ?")
      .get(registryId) as SharedSkillSyncStateRow | undefined;
    return row ? mapSyncStateRow(row) : { registryId };
  }

  public recordSyncSuccess(registryId: string, cursor?: string): void {
    assertRegistryId(registryId);
    this.database
      .prepare(
        `
          INSERT INTO shared_skill_sync_state (
            registry_id, last_success_at, cursor, last_error
          ) VALUES (?, ?, ?, NULL)
          ON CONFLICT(registry_id) DO UPDATE SET
            last_success_at = excluded.last_success_at,
            cursor = excluded.cursor,
            last_error = NULL
        `,
      )
      .run(registryId, new Date().toISOString(), cursor ?? null);
  }

  public recordSyncFailure(registryId: string, message: string): void {
    assertRegistryId(registryId);
    this.database
      .prepare(
        `
          INSERT INTO shared_skill_sync_state (
            registry_id, last_success_at, cursor, last_error
          ) VALUES (?, NULL, NULL, ?)
          ON CONFLICT(registry_id) DO UPDATE SET
            last_error = excluded.last_error
        `,
      )
      .run(registryId, sanitizeError(message));
  }
}

function createSharedSkillTables(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS shared_skills (
      registry_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      version TEXT NOT NULL,
      name TEXT NOT NULL,
      operation_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      definition_json TEXT NOT NULL,
      fast_path_eligible INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (registry_id, skill_id)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS shared_skills_match
      ON shared_skills (registry_id, operation_key, fingerprint);

    CREATE TABLE IF NOT EXISTS shared_skill_outbox (
      id TEXT PRIMARY KEY,
      registry_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (registry_id, content_hash)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS shared_skill_sync_state (
      registry_id TEXT PRIMARY KEY,
      last_success_at TEXT,
      cursor TEXT,
      last_error TEXT
    ) STRICT;
  `);
}

function mapSharedSkillRow(row: SharedSkillRow): SharedSkillRecord {
  return {
    registryId: row.registry_id,
    skillId: row.skill_id,
    version: row.version,
    name: row.name,
    operationKey: row.operation_key,
    fingerprint: row.fingerprint,
    definition: JSON.parse(row.definition_json) as Record<string, unknown>,
    fastPathEligible: row.fast_path_eligible === 1,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

function mapOutboxRow(row: SharedSkillOutboxRow): SharedSkillOutboxEntry {
  return {
    id: row.id,
    registryId: row.registry_id,
    contentHash: row.content_hash,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at,
    attemptCount: row.attempt_count,
  };
}

function mapSyncStateRow(row: SharedSkillSyncStateRow): SharedSkillSyncState {
  return {
    registryId: row.registry_id,
    ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    ...(row.cursor ? { cursor: row.cursor } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function assertRegistryId(registryId: string): void {
  if (!registryId.trim()) {
    throw new Error("Shared skill registryId must not be empty.");
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error(
      "Shared skill list limit must be an integer between 1 and 1000.",
    );
  }
}

function sanitizeError(message: string): string {
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
