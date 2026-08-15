import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import {
  isMemoryRecord,
  type CodeMemoryAnchor,
  type MemoryRecord,
} from "@lhic/schema";

export interface TrustedMemoryStoreOptions {
  databaseFile: string;
}

export type AnchorFreshness = {
  status: "fresh" | "changed" | "missing";
  confidence: number;
};

/**
 * Namespaced memory with explicit trust. Retrieval policy: Fast Path may use
 * only verifier-backed or cryptographically verified shared records; lower-
 * trust memory (observed, model_extracted, user_provided) is labeled and
 * never promoted by serialization. Code-anchored records lose confidence
 * when the anchored files change.
 */
export class TrustedMemoryStore {
  private readonly database: DatabaseSync;

  public constructor(options: TrustedMemoryStoreOptions) {
    mkdirSync(dirname(options.databaseFile), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(options.databaseFile);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        trust TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        source_task_id TEXT,
        source_receipts TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        stale_after TEXT,
        code_anchor TEXT,
        confidence REAL,
        invalidated_at TEXT,
        invalidated_reason TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS memory_records_namespace
        ON memory_records (namespace, trust);
    `);
  }

  public close(): void {
    this.database.close();
  }

  public save(record: MemoryRecord): void {
    if (!isMemoryRecord(record)) {
      throw new Error("Refusing to persist a malformed memory record.");
    }
    this.database
      .prepare(
        `INSERT INTO memory_records (
           id, namespace, trust, content_hash, source_task_id, source_receipts,
           created_at, stale_after, code_anchor, confidence, invalidated_at,
           invalidated_reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           namespace = excluded.namespace,
           trust = excluded.trust,
           content_hash = excluded.content_hash,
           source_task_id = excluded.source_task_id,
           source_receipts = excluded.source_receipts,
           stale_after = excluded.stale_after,
           code_anchor = excluded.code_anchor,
           confidence = excluded.confidence,
           invalidated_at = excluded.invalidated_at,
           invalidated_reason = excluded.invalidated_reason`,
      )
      .run(
        record.id,
        record.namespace,
        record.trust,
        record.contentHash,
        record.sourceTaskId ?? null,
        JSON.stringify(record.sourceReceiptIds ?? []),
        record.createdAt,
        record.staleAfter ?? null,
        record.codeAnchor ? JSON.stringify(record.codeAnchor) : null,
        record.confidence ?? null,
        record.invalidatedAt ?? null,
        record.invalidationReason ?? null,
      );
  }

  public get(id: string): MemoryRecord | undefined {
    const row = this.database
      .prepare(`SELECT * FROM memory_records WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToRecord(row) : undefined;
  }

  public listByNamespace(namespace: MemoryRecord["namespace"]): MemoryRecord[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM memory_records WHERE namespace = ? ORDER BY created_at`,
      )
      .all(namespace) as Array<Record<string, unknown>>;
    return rows
      .map((row) => this.rowToRecord(row))
      .filter((record): record is MemoryRecord => record !== undefined);
  }

  public invalidate(id: string, reason: string): void {
    this.database
      .prepare(
        `UPDATE memory_records
         SET invalidated_at = ?, invalidated_reason = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), reason, id);
  }

  /** Fast Path eligibility: only verifier-backed/shared-signed, non-stale. */
  public static fastPathEligible(
    record: MemoryRecord,
    now = new Date(),
  ): boolean {
    if (record.invalidatedAt) return false;
    if (
      record.trust !== "verifier_backed" &&
      record.trust !== "shared_signed"
    ) {
      return false;
    }
    if (record.staleAfter && Date.parse(record.staleAfter) <= now.getTime()) {
      return false;
    }
    return true;
  }

  /** Slow Path/coding context may use lower-trust memory with labels. */
  public static retrievalLabel(record: MemoryRecord): string {
    return `${record.namespace}:${record.trust}${record.invalidatedAt ? ":invalidated" : ""}`;
  }

  /**
   * Code-aware staleness: compares anchored file hashes against current
   * content. A changed anchor reduces confidence; a missing file marks the
   * anchor broken. Unchanged anchors stay fresh.
   */
  public static async checkAnchorFreshness(
    anchor: CodeMemoryAnchor,
    readHash: (path: string) => Promise<string | undefined>,
  ): Promise<AnchorFreshness> {
    let changed = 0;
    let missing = 0;
    for (const path of anchor.paths) {
      const expected = anchor.pathHashes[path];
      const actual = await readHash(path);
      if (actual === undefined) {
        missing += 1;
      } else if (expected !== undefined && actual !== expected) {
        changed += 1;
      }
    }
    if (changed > 0) {
      return { status: "changed", confidence: 0.1 };
    }
    if (missing > 0) {
      return { status: "missing", confidence: 0.25 };
    }
    return { status: "fresh", confidence: 1 };
  }

  private rowToRecord(row: Record<string, unknown>): MemoryRecord | undefined {
    const record: MemoryRecord = {
      schemaVersion: "lhic-memory-v1",
      id: String(row.id),
      namespace: row.namespace as MemoryRecord["namespace"],
      trust: row.trust as MemoryRecord["trust"],
      contentHash: String(row.content_hash),
      createdAt: String(row.created_at),
      ...(row.source_task_id
        ? { sourceTaskId: String(row.source_task_id) }
        : {}),
      ...(row.stale_after ? { staleAfter: String(row.stale_after) } : {}),
      ...(row.code_anchor
        ? {
            codeAnchor: JSON.parse(String(row.code_anchor)) as CodeMemoryAnchor,
          }
        : {}),
      ...(row.confidence !== null && row.confidence !== undefined
        ? { confidence: Number(row.confidence) }
        : {}),
      ...(row.invalidated_at
        ? {
            invalidatedAt: String(row.invalidated_at),
            invalidationReason: String(row.invalidated_reason ?? "invalidated"),
          }
        : {}),
    };
    const receipts = JSON.parse(String(row.source_receipts)) as unknown;
    if (Array.isArray(receipts)) {
      record.sourceReceiptIds = receipts.filter(
        (receipt): receipt is string => typeof receipt === "string",
      );
    }
    return isMemoryRecord(record) ? record : undefined;
  }
}
