import type {
  ApprovalRecord,
  ObservationOutcome,
  ResearchAction,
  SideEffectLedgerEntry,
  VerificationEvidence,
} from "./model.ts";
import { approvalAllows } from "./approval.ts";
import { FileSideEffectLedger } from "./ledger.ts";
import { effectiveSideEffectClass, inferSideEffectClass } from "./policy.ts";
import { decideRecovery } from "./recovery.ts";

export interface BoundaryResult {
  actionId: string;
  state: SideEffectLedgerEntry["state"];
  dispatchAllowed: boolean;
  reason: string;
}

/**
 * Split-phase execution boundary for runners that must retain control of the
 * physical tool call (for example, an official benchmark's env.step()).
 *
 * Unlike LhicResearchKernel.run(), this class does not invoke the external
 * action itself. The caller must call prepare() BEFORE physical dispatch and
 * then recordResponse()/recordLostResponse() afterward.
 */
export class SplitExecutionBoundary {
  public constructor(private readonly ledger: FileSideEffectLedger) {}

  public async prepare(
    action: ResearchAction,
    approval?: ApprovalRecord,
  ): Promise<BoundaryResult> {
    const inferred = inferSideEffectClass(action);
    const effective = effectiveSideEffectClass(action.plannerSideEffectClass, inferred);
    const now = new Date();
    const approvalCheck = approvalAllows(approval, action, effective, {
      now,
      ...(action.origin ? { resolvedOrigin: action.origin } : {}),
    });
    const existing = this.ledger.get(action.actionId);

    if (existing) {
      if (
        existing.state === "verified" ||
        existing.state === "possibly_committed" ||
        existing.state === "executed" ||
        existing.state === "needs_resolution" ||
        existing.state === "failed" ||
        existing.state === "rolled_back"
      ) {
        return {
          actionId: action.actionId,
          state: existing.state,
          dispatchAllowed: false,
          reason:
            existing.state === "verified"
              ? "Replay blocked: action identity is already verified."
              : `Dispatch blocked: action identity is already in durable state ${existing.state}.`,
        };
      }
    }

    if (!approvalCheck.allowed) {
      if (!existing) {
        await this.ledger.put({
          schemaVersion: "lhic-side-effect-ledger-v1",
          actionId: action.actionId,
          actionHash: action.actionHash,
          taskId: action.taskId,
          surface: action.surface,
          sideEffectClass: effective,
          state: "failed",
          ...(approval ? { approvalId: approval.approvalId } : {}),
          evidenceIds: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        });
      }
      return {
        actionId: action.actionId,
        state: "failed",
        dispatchAllowed: false,
        reason: approvalCheck.reason,
      };
    }

    if (!existing) {
      await this.ledger.put({
        schemaVersion: "lhic-side-effect-ledger-v1",
        actionId: action.actionId,
        actionHash: action.actionHash,
        taskId: action.taskId,
        surface: action.surface,
        sideEffectClass: effective,
        state: approval ? "approved" : "proposed",
        ...(approval ? { approvalId: approval.approvalId } : {}),
        evidenceIds: [],
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }

    // The core ordering invariant: ambiguity is durable before the caller is
    // allowed to perform the external action.
    const prepared = await this.ledger.transition(action.actionId, "possibly_committed");
    return {
      actionId: action.actionId,
      state: prepared.state,
      dispatchAllowed: true,
      reason: "Durable ambiguity persisted; external dispatch may proceed.",
    };
  }

  /** Record transport/executor completion only. This is NOT verification. */
  public async recordResponse(actionId: string): Promise<BoundaryResult> {
    const existing = this.require(actionId);
    if (existing.state === "possibly_committed") {
      const executed = await this.ledger.transition(actionId, "executed");
      return {
        actionId,
        state: executed.state,
        dispatchAllowed: false,
        reason: "Executor returned; action is executed but not independently verified.",
      };
    }
    return {
      actionId,
      state: existing.state,
      dispatchAllowed: false,
      reason: `Executor response recorded after state ${existing.state}; no replay admitted.`,
    };
  }

  /** A missing response leaves possibly_committed ambiguity intact. */
  public recordLostResponse(actionId: string): BoundaryResult {
    const existing = this.require(actionId);
    return {
      actionId,
      state: existing.state,
      dispatchAllowed: false,
      reason: "Completion was lost; durable external outcome remains unresolved.",
    };
  }

  /** Apply an externally obtained recovery observation and optional verifier evidence. */
  public async recover(
    actionId: string,
    observation: ObservationOutcome,
    evidence?: VerificationEvidence,
  ): Promise<BoundaryResult> {
    const existing = this.require(actionId);
    if (existing.state === "verified") {
      return {
        actionId,
        state: "verified",
        dispatchAllowed: false,
        reason: "Verified action identity is terminal.",
      };
    }
    if (
      existing.state !== "possibly_committed" &&
      existing.state !== "executed" &&
      existing.state !== "needs_resolution"
    ) {
      return {
        actionId,
        state: existing.state,
        dispatchAllowed: false,
        reason: `State ${existing.state} is not eligible for ambiguity recovery.`,
      };
    }

    const verifierPassed = evidence?.result === "passed" && evidence.artifactHashes.length > 0;
    const decision = decideRecovery(existing, observation, verifierPassed);
    if (decision.nextState !== existing.state) {
      await this.ledger.transition(actionId, decision.nextState, evidence?.evidenceId);
    }
    const state = this.require(actionId).state;
    return {
      actionId,
      state,
      // Recovery may determine that retry could be safe, but the boundary never
      // auto-dispatches. A separate policy/operator decision is required.
      dispatchAllowed: false,
      reason: decision.reason,
    };
  }

  public state(actionId: string): SideEffectLedgerEntry | undefined {
    return this.ledger.get(actionId);
  }

  private require(actionId: string): SideEffectLedgerEntry {
    const entry = this.ledger.get(actionId);
    if (!entry) throw new Error(`Unknown boundary action: ${actionId}`);
    return entry;
  }
}
