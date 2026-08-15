import { DatabaseSync } from "node:sqlite";

import {
  isSideEffectLedgerEntry,
  type LedgerState,
  type SideEffectLedgerEntry,
} from "@lhic/schema";

import {
  createLedgerDatabase,
  jsonArray,
  parseJsonArray,
} from "./ledger-database.js";

export interface SideEffectLedgerOptions {
  databaseFile: string;
}

/** Valid state transitions (fail-closed: anything else is rejected). */
const allowedTransitions: Record<LedgerState, readonly LedgerState[]> = {
  proposed: ["approved", "dispatching", "failed", "needs_resolution"],
  approved: ["dispatching", "failed", "needs_resolution"],
  dispatching: ["possibly_committed", "failed", "needs_resolution", "verified"],
  possibly_committed: ["executed", "needs_resolution", "verified"],
  executed: ["verified", "failed", "needs_resolution"],
  verified: [],
  failed: [],
  needs_resolution: ["rolled_back", "executed"],
  rolled_back: [],
};

/**
 * Durable side-effect state machine. Transitions are atomic SQLite updates;
 * `possibly_committed` is written before physical dispatch so a crash leaves
 * an ambiguous, re-observable state instead of a silent "not executed".
 * `verified` entries are terminal and never repeated.
 */
export class SideEffectLedger {
  private readonly database: DatabaseSync;
  private closed = false;

  public constructor(options: SideEffectLedgerOptions) {
    this.database = createLedgerDatabase(options.databaseFile);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  public put(
    entry: SideEffectLedgerEntry,
    options: { overwrite?: boolean } = {},
  ): void {
    if (!isSideEffectLedgerEntry(entry)) {
      throw new Error("Refusing to persist a malformed ledger entry.");
    }
    const existing = this.get(entry.actionId);
    if (existing) {
      if (!options.overwrite) {
        throw new Error(
          `Ledger entry ${entry.actionId} already exists; refusing a duplicate action ID.`,
        );
      }
      // Metadata refresh (evidence refs, timestamps) without a state change.
      this.database
        .prepare(
          `UPDATE side_effect_ledger SET
             precondition_evidence = ?, verifier_evidence = ?, updated_at = ?
           WHERE action_id = ?`,
        )
        .run(
          jsonArray(entry.preconditionEvidenceRefs ?? []),
          jsonArray(entry.verifierEvidenceRefs ?? []),
          entry.updatedAt,
          entry.actionId,
        );
      return;
    }
    this.database
      .prepare(
        `INSERT INTO side_effect_ledger
          (action_id, action_hash, task_id, surface, side_effect_class, state,
           approval_expires_at, idempotency_key, precondition_evidence,
           verifier_evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.actionId,
        entry.actionHash,
        entry.taskId,
        entry.surface,
        entry.sideEffectClass,
        entry.state,
        entry.approvalExpiresAt ?? null,
        entry.idempotencyKey ?? null,
        jsonArray(entry.preconditionEvidenceRefs ?? []),
        jsonArray(entry.verifierEvidenceRefs ?? []),
        entry.createdAt,
        entry.updatedAt,
      );
  }

  public get(actionId: string): SideEffectLedgerEntry | undefined {
    const row = this.database
      .prepare(
        `SELECT action_id, action_hash, task_id, surface, side_effect_class,
                state, approval_expires_at, idempotency_key,
                precondition_evidence, verifier_evidence, created_at, updated_at
         FROM side_effect_ledger WHERE action_id = ?`,
      )
      .get(actionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const entry: SideEffectLedgerEntry = {
      schemaVersion: "lhic-side-effect-ledger-v1",
      actionId: String(row.action_id),
      actionHash: String(row.action_hash),
      taskId: String(row.task_id),
      surface: row.surface as SideEffectLedgerEntry["surface"],
      sideEffectClass:
        row.side_effect_class as SideEffectLedgerEntry["sideEffectClass"],
      state: row.state as LedgerState,
      ...(row.approval_expires_at
        ? { approvalExpiresAt: String(row.approval_expires_at) }
        : {}),
      ...(row.idempotency_key
        ? { idempotencyKey: String(row.idempotency_key) }
        : {}),
      preconditionEvidenceRefs: parseJsonArray(
        String(row.precondition_evidence),
      ),
      verifierEvidenceRefs: parseJsonArray(String(row.verifier_evidence)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
    return entry;
  }

  /** Atomic transition; invalid transitions fail closed. */
  public transition(actionId: string, next: LedgerState): void {
    const existing = this.get(actionId);
    if (!existing) {
      throw new Error(
        `Cannot transition unknown ledger entry ${actionId} to ${next}.`,
      );
    }
    const allowed = allowedTransitions[existing.state];
    if (!allowed.includes(next)) {
      throw new Error(
        `Invalid ledger transition ${existing.state} -> ${next} for ${actionId}.`,
      );
    }
    this.database
      .prepare(
        `UPDATE side_effect_ledger
         SET state = ?, updated_at = ? WHERE action_id = ?`,
      )
      .run(next, new Date().toISOString(), actionId);
  }

  /** Durable recovery query: entries that need re-observation. */
  public ambiguousForRecovery(): SideEffectLedgerEntry[] {
    return this.list().filter((entry) =>
      ["dispatching", "possibly_committed", "executed"].includes(entry.state),
    );
  }

  public verified(actionId: string): boolean {
    return this.get(actionId)?.state === "verified";
  }

  public list(): SideEffectLedgerEntry[] {
    const rows = this.database
      .prepare(
        `SELECT action_id, action_hash, task_id, surface, side_effect_class,
                state, approval_expires_at, idempotency_key,
                precondition_evidence, verifier_evidence, created_at, updated_at
         FROM side_effect_ledger ORDER BY created_at`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows
      .map((row) => {
        const entry: SideEffectLedgerEntry = {
          schemaVersion: "lhic-side-effect-ledger-v1",
          actionId: String(row.action_id),
          actionHash: String(row.action_hash),
          taskId: String(row.task_id),
          surface: row.surface as SideEffectLedgerEntry["surface"],
          sideEffectClass:
            row.side_effect_class as SideEffectLedgerEntry["sideEffectClass"],
          state: row.state as LedgerState,
          ...(row.approval_expires_at
            ? { approvalExpiresAt: String(row.approval_expires_at) }
            : {}),
          ...(row.idempotency_key
            ? { idempotencyKey: String(row.idempotency_key) }
            : {}),
          preconditionEvidenceRefs: parseJsonArray(
            String(row.precondition_evidence),
          ),
          verifierEvidenceRefs: parseJsonArray(String(row.verifier_evidence)),
          createdAt: String(row.created_at),
          updatedAt: String(row.updated_at),
        };
        return isSideEffectLedgerEntry(entry) ? entry : undefined;
      })
      .filter((entry): entry is SideEffectLedgerEntry => entry !== undefined);
  }

  /**
   * Approval scope usage counter: consumes one action for an
   * origin_action_class scope and returns the new count.
   */
  public consumeScopeAction(approvalId: string): number {
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO approval_scope_usage (approval_id, actions_used, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(approval_id) DO UPDATE SET
           actions_used = actions_used + 1, updated_at = excluded.updated_at`,
      )
      .run(approvalId, now);
    const row = this.database
      .prepare(
        `SELECT actions_used FROM approval_scope_usage WHERE approval_id = ?`,
      )
      .get(approvalId) as { actions_used: number } | undefined;
    return row ? Number(row.actions_used) : 1;
  }

  public scopeUsage(approvalId: string): number {
    const row = this.database
      .prepare(
        `SELECT actions_used FROM approval_scope_usage WHERE approval_id = ?`,
      )
      .get(approvalId) as { actions_used: number } | undefined;
    return row ? Number(row.actions_used) : 0;
  }
}
