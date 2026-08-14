import type { SideEffectClass } from "@lhic/schema";
import type { SideEffectLedgerEntry } from "@lhic/schema";
import type { SideEffectLedger } from "@lhic/ledger";

export interface LedgerCoordinatorOptions {
  ledger: SideEffectLedger;
  taskId: string;
  surface: SideEffectLedgerEntry["surface"];
}

/**
 * Crash-safe execution state machine for one task. `possibly_committed` is
 * written BEFORE the physical dispatch: a crash mid-dispatch leaves an
 * ambiguous, re-observable state. Recovery never blindly replays; it
 * re-observes the world and only marks verified when the side effect is
 * proven to have happened.
 */
export class LedgerCoordinator {
  private readonly ledger: SideEffectLedger;
  private readonly taskId: string;
  private readonly surface: SideEffectLedgerEntry["surface"];

  public constructor(options: LedgerCoordinatorOptions) {
    this.ledger = options.ledger;
    this.taskId = options.taskId;
    this.surface = options.surface;
  }

  /** Current durable entry for an action, if any. */
  public get(actionId: string): SideEffectLedgerEntry | undefined {
    return this.ledger.get(actionId);
  }

  public begin(
    actionId: string,
    actionHash: string,
    sideEffectClass: SideEffectClass,
    approvalExpiresAt?: string,
  ): void {
    const now = new Date().toISOString();
    this.ledger.put({
      schemaVersion: "lhic-side-effect-ledger-v1",
      actionId,
      actionHash,
      taskId: this.taskId,
      surface: this.surface,
      sideEffectClass,
      state: "proposed",
      ...(approvalExpiresAt ? { approvalExpiresAt } : {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  public approve(actionId: string): void {
    this.ledger.transition(actionId, "approved");
  }

  /**
   * Marks the action as ambiguous and dispatches. Callers must call this
   * immediately before the physical side effect.
   */
  public beforeDispatch(actionId: string): void {
    this.ledger.transition(actionId, "dispatching");
    this.ledger.transition(actionId, "possibly_committed");
  }

  /** Physical dispatch completed and returned (may still be unverified). */
  public afterDispatch(actionId: string): void {
    this.ledger.transition(actionId, "executed");
  }

  public verifySucceeded(actionId: string, evidenceRefs: string[]): void {
    const entry = this.ledger.get(actionId);
    if (!entry) return;
    this.ledger.put(
      {
        ...entry,
        verifierEvidenceRefs: evidenceRefs,
        updatedAt: new Date().toISOString(),
      },
      { overwrite: true },
    );
    this.ledger.transition(actionId, "verified");
  }

  public verifyFailed(actionId: string): void {
    this.ledger.transition(actionId, "failed");
  }

  public needsResolution(actionId: string): void {
    this.ledger.transition(actionId, "needs_resolution");
  }

  /** Entries for this task that need re-observation after a crash. */
  public recoverPending(): SideEffectLedgerEntry[] {
    return this.ledger
      .ambiguousForRecovery()
      .filter((entry) => entry.taskId === this.taskId);
  }

  /**
   * Recovery decision after re-observation: a proven side effect is marked
   * verified (never repeated); an unproven one stays needs_resolution and is
   * never blindly replayed.
   */
  public recover(
    actionId: string,
    observation: { sideEffectHappened: boolean; evidenceRefs: string[] },
  ): "verified" | "needs_resolution" {
    if (observation.sideEffectHappened) {
      this.verifySucceeded(actionId, observation.evidenceRefs);
      return "verified";
    }
    this.needsResolution(actionId);
    return "needs_resolution";
  }
}
