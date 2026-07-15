import type { DatabaseSync } from "node:sqlite";

import type { VerificationResult } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

export interface SelectorMemoryEntry {
  skillName: string;
  target: string;
  selector: string;
  role?: string;
  label?: string;
  successCount: number;
  failureCount: number;
  lastSuccessAt?: string;
}

interface SelectorRow {
  skill_name: string;
  target: string;
  selector: string;
  role: string | null;
  label: string | null;
  success_count: number;
  failure_count: number;
  last_success_at: string | null;
}

export class SelectorMemory {
  public constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS selectors (
        skill_name TEXT NOT NULL,
        target TEXT NOT NULL,
        selector TEXT NOT NULL,
        role TEXT,
        label TEXT,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT,
        PRIMARY KEY(skill_name, target, selector)
      ) STRICT;
    `);
  }

  public remember(
    entry: Pick<
      SelectorMemoryEntry,
      "skillName" | "target" | "selector" | "role" | "label"
    >,
    verification: VerificationResult,
  ): boolean {
    if (!verification.success || verification.evidence.length === 0) {
      return false;
    }
    const safe = redactPII(entry);
    this.database
      .prepare(
        `
        INSERT INTO selectors (skill_name, target, selector, role, label, success_count, last_success_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(skill_name, target, selector) DO UPDATE SET
          success_count = success_count + 1,
          last_success_at = excluded.last_success_at
      `,
      )
      .run(
        safe.skillName,
        safe.target,
        safe.selector,
        safe.role ?? null,
        safe.label ?? null,
        new Date().toISOString(),
      );
    return true;
  }

  public find(skillName: string, target: string): SelectorMemoryEntry[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM selectors WHERE skill_name = ? AND target = ? ORDER BY success_count DESC, last_success_at DESC",
      )
      .all(skillName, target) as unknown as SelectorRow[];
    return rows.map((row) => ({
      skillName: row.skill_name,
      target: row.target,
      selector: row.selector,
      ...(row.role ? { role: row.role } : {}),
      ...(row.label ? { label: row.label } : {}),
      successCount: row.success_count,
      failureCount: row.failure_count,
      ...(row.last_success_at ? { lastSuccessAt: row.last_success_at } : {}),
    }));
  }
}
