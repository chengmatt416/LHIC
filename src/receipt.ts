import type {
  AgentActionReceipt,
  ApprovalRecord,
  LedgerState,
  ResearchAction,
  SideEffectClass,
  VerificationEvidence,
} from "./model.ts";

export interface ReceiptInput {
  receiptId: string;
  action: ResearchAction;
  sideEffectClass: SideEffectClass;
  ledgerState: LedgerState;
  approval?: ApprovalRecord;
  executionAuthority?: "lhic" | "external";
  evidence?: VerificationEvidence[];
  failureReason?: string;
  createdAt?: string;
  completedAt?: string;
}

/**
 * Receipt construction preserves authority separation. An executor reporting
 * success is never upgraded to verified unless an independent verifier has
 * passed and emitted non-empty evidence.
 */
export function buildReceipt(input: ReceiptInput): AgentActionReceipt {
  const evidence = input.evidence ?? [];
  const passedEvidence = evidence.filter((item) => item.result === "passed");
  const verified = input.ledgerState === "verified" && passedEvidence.length > 0;

  return {
    schemaVersion: "lhic-action-receipt-v1",
    receiptId: input.receiptId,
    actionId: input.action.actionId,
    taskId: input.action.taskId,
    surface: input.action.surface,
    tool: input.action.tool,
    sideEffectClass: input.sideEffectClass,
    plannerAuthority: "planner",
    approvalAuthority: input.approval?.authority ?? "none",
    executionAuthority: input.executionAuthority ?? "lhic",
    verificationAuthority: verified
      ? passedEvidence[0]?.verifier ?? "none"
      : "none",
    ledgerState: verified
      ? "verified"
      : input.ledgerState === "verified"
        ? "executed"
        : input.ledgerState,
    ...(input.approval ? { approvalScope: input.approval.scope } : {}),
    evidence,
    ...(input.failureReason ? { failureReason: input.failureReason } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
  };
}
