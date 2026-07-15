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

  public recommendationFor(rootCause: FailureType): string {
    return recoveryRules[rootCause];
  }
}
