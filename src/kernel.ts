import type {
  AgentActionReceipt,
  ApprovalRecord,
  ExecutionResult,
  ObservationOutcome,
  ResearchAction,
  SideEffectLedgerEntry,
  VerificationEvidence,
} from "./model.ts";
import { approvalAllows } from "./approval.ts";
import { FileSideEffectLedger } from "./ledger.ts";
import { effectiveSideEffectClass, inferSideEffectClass } from "./policy.ts";
import { decideRecovery } from "./recovery.ts";
import { buildReceipt } from "./receipt.ts";

export interface KernelAdapters {
  execute(action: ResearchAction): Promise<ExecutionResult>;
  verify(action: ResearchAction): Promise<VerificationEvidence>;
  observe(action: ResearchAction): Promise<ObservationOutcome>;
}

export class LhicResearchKernel {
  private readonly ledger: FileSideEffectLedger;
  private readonly adapters: KernelAdapters;

  public constructor(ledger: FileSideEffectLedger, adapters: KernelAdapters) {
    this.ledger = ledger;
    this.adapters = adapters;
  }

  public async run(
    action: ResearchAction,
    approval?: ApprovalRecord,
  ): Promise<AgentActionReceipt> {
    const inferred = inferSideEffectClass(action);
    const effective = effectiveSideEffectClass(action.plannerSideEffectClass, inferred);
    const now = new Date();
    const approvalCheck = approvalAllows(approval, action, effective, {
      now,
      ...(action.origin ? { resolvedOrigin: action.origin } : {}),
    });

    const existing = this.ledger.get(action.actionId);
    if (existing?.state === "verified") {
      return buildReceipt({
        receiptId: `receipt:${action.actionId}:replay-blocked`,
        action,
        sideEffectClass: effective,
        ledgerState: "verified",
        ...(approval ? { approval } : {}),
        evidence: [],
        failureReason: "Replay blocked: action identity is already verified.",
      });
    }

    if (!approvalCheck.allowed) {
      const denied: SideEffectLedgerEntry = existing ?? {
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
      };
      if (!existing) await this.ledger.put(denied);
      return buildReceipt({
        receiptId: `receipt:${action.actionId}`,
        action,
        sideEffectClass: effective,
        ledgerState: "failed",
        ...(approval ? { approval } : {}),
        failureReason: approvalCheck.reason,
      });
    }

    if (
      existing &&
      (existing.state === "possibly_committed" ||
        existing.state === "executed" ||
        existing.state === "needs_resolution")
    ) {
      return this.recover(action, existing, approval);
    }

    const entry: SideEffectLedgerEntry = existing ?? {
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
    };
    if (!existing) await this.ledger.put(entry);

    // Critical protocol point: persist ambiguity BEFORE external dispatch.
    await this.ledger.transition(action.actionId, "possibly_committed");

    const execution = await this.adapters.execute(action);
    if (!execution.responseReceived) {
      return buildReceipt({
        receiptId: `receipt:${action.actionId}`,
        action,
        sideEffectClass: effective,
        ledgerState: "possibly_committed",
        ...(approval ? { approval } : {}),
        failureReason: "Execution response was lost; external outcome is ambiguous.",
      });
    }

    await this.ledger.transition(action.actionId, "executed");
    const evidence = await this.adapters.verify(action);
    if (evidence.result === "passed" && evidence.artifactHashes.length > 0) {
      await this.ledger.transition(action.actionId, "verified", evidence.evidenceId);
      return buildReceipt({
        receiptId: `receipt:${action.actionId}`,
        action,
        sideEffectClass: effective,
        ledgerState: "verified",
        ...(approval ? { approval } : {}),
        evidence: [evidence],
        completedAt: new Date().toISOString(),
      });
    }

    await this.ledger.transition(action.actionId, "needs_resolution", evidence.evidenceId);
    return buildReceipt({
      receiptId: `receipt:${action.actionId}`,
      action,
      sideEffectClass: effective,
      ledgerState: "needs_resolution",
      ...(approval ? { approval } : {}),
      evidence: [evidence],
      failureReason: "Postcondition verifier did not produce passing evidence.",
    });
  }

  private async recover(
    action: ResearchAction,
    entry: SideEffectLedgerEntry,
    approval?: ApprovalRecord,
  ): Promise<AgentActionReceipt> {
    const observation = await this.adapters.observe(action);
    let evidence: VerificationEvidence | undefined;
    if (observation === "effect_present") {
      evidence = await this.adapters.verify(action);
    }
    const decision = decideRecovery(entry, observation, evidence?.result === "passed");

    if (decision.nextState === "verified" && evidence) {
      await this.ledger.transition(action.actionId, "verified", evidence.evidenceId);
    } else if (decision.nextState !== entry.state) {
      await this.ledger.transition(action.actionId, decision.nextState);
    }

    return buildReceipt({
      receiptId: `receipt:${action.actionId}:recovery`,
      action,
      sideEffectClass: entry.sideEffectClass,
      ledgerState: decision.nextState,
      ...(approval ? { approval } : {}),
      ...(evidence ? { evidence: [evidence] } : {}),
      failureReason: decision.reason,
    });
  }
}
