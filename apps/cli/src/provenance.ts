import type { AgentActionReceipt } from "@lhic/schema";
import { readReceipts, receiptTimeline } from "@lhic/trace";

export interface ProvenanceLine {
  field: string;
  value: string;
}

export function provenanceLines(receipt: AgentActionReceipt): ProvenanceLine[] {
  const lines: ProvenanceLine[] = [
    { field: "Receipt", value: receipt.receiptId },
    { field: "Action", value: receipt.actionId },
    { field: "Surface", value: receipt.surface },
    { field: "Tool", value: receipt.tool },
    { field: "State", value: receipt.state },
    {
      field: "Planner",
      value: `${receipt.planner.authority}${receipt.planner.modelId ? ` / ${receipt.planner.modelId}` : ""}`,
    },
    ...(receipt.intent ? [{ field: "Proposed", value: receipt.intent }] : []),
    {
      field: "Side-effect class",
      value: receipt.sideEffectClass,
    },
    {
      field: "Risk",
      value: `${receipt.inferredRisk}${receipt.plannerRisk ? ` (planner: ${receipt.plannerRisk})` : ""}`,
    },
    {
      field: "Approval",
      value: `${receipt.approval.status} / ${receipt.approval.authority}${receipt.approval.actionHash ? ` hash=${receipt.approval.actionHash.slice(0, 16)}…` : ""}`,
    },
    {
      field: "Executor",
      value: `${receipt.executor.authority}${receipt.executor.backend ? ` / ${receipt.executor.backend}` : ""}${receipt.executor.fallbackChain ? ` fallback=${receipt.executor.fallbackChain.length}` : ""}`,
    },
    {
      field: "Verifier",
      value: `${receipt.verification.authority} / ${receipt.verification.status}`,
    },
    {
      field: "Evidence",
      value:
        receipt.verification.evidenceRefs.length > 0
          ? `${receipt.verification.evidenceRefs.length} ref(s)`
          : "none",
    },
  ];
  return lines;
}

export function renderProvenance(receipts: AgentActionReceipt[]): string {
  const timeline = receiptTimeline(receipts);
  if (timeline.length === 0) return "No action receipts found.";
  const blocks = timeline.map((receipt) => {
    const rows = provenanceLines(receipt).map(
      (line) => `${line.field.padEnd(18)}${line.value}`,
    );
    return rows.join("\n");
  });
  return blocks.join("\n\n");
}

export function provenanceJson(receipts: AgentActionReceipt[]): string {
  return JSON.stringify(
    receiptTimeline(receipts).map((receipt) => ({
      receiptId: receipt.receiptId,
      actionId: receipt.actionId,
      surface: receipt.surface,
      tool: receipt.tool,
      state: receipt.state,
      sideEffectClass: receipt.sideEffectClass,
      planner: receipt.planner,
      approval: receipt.approval,
      executor: receipt.executor,
      verification: receipt.verification,
    })),
    null,
    2,
  );
}
