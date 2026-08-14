import { randomUUID } from "node:crypto";

import type {
  AgentActionReceipt,
  BrowserSemanticAction,
  GlobalComputerAction,
} from "@lhic/schema";
import type { ActionApproval } from "@lhic/security";
import { effectiveSideEffectClass, inferSideEffectClass } from "@lhic/security";
import { appendReceipt, hashState } from "@lhic/trace";

export interface ReceiptRecord {
  surface: "browser" | "desktop";
  actionId: string;
  tool: string;
  action: BrowserSemanticAction | GlobalComputerAction;
  plannerModelId?: string;
  approval?: ActionApproval;
  approvalStatus?: "approved" | "denied" | "not_required" | "expired";
  executorBackend?: string;
  fallbackChain?: AgentActionReceipt["executor"]["fallbackChain"];
  verificationStatus?: "passed" | "failed" | "inconclusive" | "not_run";
  verificationAuthority?: "lhic" | "external-verifier" | "omp" | "none";
  evidenceRefs?: string[];
  state: AgentActionReceipt["state"];
  failureReason?: string;
  startedAt: string;
}

/**
 * Emits normalized LHIC action receipts for browser/desktop execution.
 * Authority is explicit: executor = LHIC, verification = LHIC only when a
 * verifier ran and produced evidence; OMP-native events never carry LHIC
 * verification labels here.
 */
export class ReceiptRecorder {
  public constructor(
    private readonly receiptLogPath: string,
    private readonly taskId: string,
    private readonly sessionId?: string,
  ) {}

  public async record(input: ReceiptRecord): Promise<string> {
    const inferred = inferSideEffectClass(input.action);
    const receipt: AgentActionReceipt = {
      schemaVersion: "lhic-action-receipt-v1",
      receiptId: randomUUID(),
      actionId: input.actionId,
      taskId: this.taskId,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      surface: input.surface,
      tool: input.tool,
      ...(input.action.intent ? { intent: input.action.intent } : {}),
      proposedAction: input.action,
      sideEffectClass: effectiveSideEffectClass(undefined, inferred),
      inferredRisk: input.action.riskLevel,
      approval: {
        required:
          input.approval !== undefined || input.approvalStatus === "denied",
        status: input.approvalStatus ?? "not_required",
        authority: input.approval ? "lhic" : "none",
        ...(input.approval ? { actionHash: input.approval.actionHash } : {}),
        ...(input.approval?.approvedBy
          ? { approvedBy: input.approval.approvedBy }
          : {}),
        ...(input.approval?.approvedAt
          ? { approvedAt: input.approval.approvedAt }
          : {}),
        ...(input.approval?.expiresAt
          ? { expiresAt: input.approval.expiresAt }
          : {}),
      },
      planner: {
        authority: "omp",
        ...(input.plannerModelId ? { modelId: input.plannerModelId } : {}),
      },
      executor: {
        authority: "lhic",
        ...(input.executorBackend ? { backend: input.executorBackend } : {}),
        ...(input.fallbackChain ? { fallbackChain: input.fallbackChain } : {}),
      },
      verification: {
        authority: input.verificationAuthority ?? "none",
        status: input.verificationStatus ?? "not_run",
        evidenceRefs: input.evidenceRefs ?? [],
      },
      state: input.state,
      ...(input.evidenceRefs
        ? { postconditionEvidenceRefs: input.evidenceRefs }
        : {}),
      ...(input.failureReason ? { failureReason: input.failureReason } : {}),
      startedAt: input.startedAt,
      completedAt: new Date().toISOString(),
    };
    await appendReceipt(this.receiptLogPath, receipt);
    return receipt.receiptId;
  }
}

/** Evidence refs: bounded per-item digests, never raw payload dumps. */
export function evidenceRefs(evidence: string[]): string[] {
  return evidence.map((item) => `evidence:${hashState(item)}`);
}
