import type { DatabaseSync } from "node:sqlite";

export type FailureType =
  | "button_disabled"
  | "field_validation_error"
  | "download_timeout"
  | "selector_not_found"
  | "unknown";

export interface RecoveryRecord {
  skillName: string;
  rootCause: FailureType;
  recommendation: string;
  occurrences: number;
  suggestsUpdatedSkillRule: boolean;
}

const recoveryRules: Record<FailureType, string> = {
  button_disabled: "Inspect required fields before retrying the button.",
  field_validation_error:
    "Map validation error text to its field and correct the field value.",
  download_timeout:
    "Retry the trigger once, then inspect network and filesystem evidence.",
  selector_not_found:
    "Fall back to label or role lookup before changing a selector.",
  unknown:
    "Collect verifier evidence and request human guidance before retrying.",
};

export class FailureMemory {
  public constructor(private readonly database: DatabaseSync) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS failures (
        id INTEGER PRIMARY KEY,
        skill_name TEXT NOT NULL,
        root_cause TEXT NOT NULL,
        recovery_rule TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  public record(skillName: string, rootCause: FailureType): RecoveryRecord {
    const recommendation = recoveryRules[rootCause];
    this.database
      .prepare(
        "INSERT INTO failures (skill_name, root_cause, recovery_rule, occurred_at) VALUES (?, ?, ?, ?)",
      )
      .run(skillName, rootCause, recommendation, new Date().toISOString());
    const countRow = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM failures WHERE skill_name = ? AND root_cause = ?",
      )
      .get(skillName, rootCause) as { count: number };
    return {
      skillName,
      rootCause,
      recommendation,
      occurrences: countRow.count,
      suggestsUpdatedSkillRule: countRow.count >= 2,
    };
  }

  public shouldBlock(
    skillName: string,
    rootCause: FailureType,
    threshold = 2,
  ): boolean {
    if (!Number.isSafeInteger(threshold) || threshold < 1 || threshold > 100) {
      throw new Error("Failure block threshold must be between 1 and 100.");
    }
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM failures WHERE skill_name = ? AND root_cause = ?",
      )
      .get(skillName, rootCause) as { count: number };
    return row.count >= threshold;
  }

  public prune(
    options: { maxEntries?: number; olderThanDays?: number } = {},
  ): number {
    const maxEntries = options.maxEntries ?? 1_000;
    const olderThanDays = options.olderThanDays ?? 30;
    if (
      !Number.isSafeInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 100_000 ||
      !Number.isSafeInteger(olderThanDays) ||
      olderThanDays < 1 ||
      olderThanDays > 3650
    ) {
      throw new Error("Failure memory pruning bounds are invalid.");
    }
    const cutoff = new Date(
      Date.now() - olderThanDays * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const removedOld = this.database
      .prepare("DELETE FROM failures WHERE occurred_at < ?")
      .run(cutoff).changes;
    const removedOverflow = this.database
      .prepare(
        `
        DELETE FROM failures
        WHERE id IN (
          SELECT id FROM failures
          ORDER BY occurred_at DESC, id DESC
          LIMIT -1 OFFSET ?
        )
      `,
      )
      .run(maxEntries).changes;
    return Number(removedOld) + Number(removedOverflow);
  }

  public recommendationFor(rootCause: FailureType): string {
    return recoveryRules[rootCause];
  }
}
