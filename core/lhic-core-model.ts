/*
 * LHIC-Core academic reference model.
 *
 * This file is intentionally small and research-facing. It captures the core
 * execution semantics without product packaging, Electron UI, provider setup,
 * or benchmark-specific glue.
 */

export type Surface = "code" | "shell" | "browser" | "desktop" | "network" | "control_plane";

export type Authority = "planner" | "operator" | "lhic" | "omp" | "external" | "none";

export type SideEffectClass =
  | "read"
  | "local_edit"
  | "local_execute"
  | "download"
  | "upload"
  | "external_write"
  | "message_send"
  | "account_change"
  | "purchase"
  | "financial_transfer"
  | "credential_change"
  | "destructive"
  | "admin_or_security_change"
  | "unknown";

export type LedgerState =
  | "proposed"
  | "approved"
  | "dispatching"
  | "possibly_committed"
  | "executed"
  | "verified"
  | "failed"
  | "needs_resolution"
  | "rolled_back";

export interface ApprovalScope {
  type: "exact_action" | "plan_step" | "task_readonly" | "origin_action_class";
  actionHash?: string;
  planId?: string;
  stepId?: string;
  taskId?: string;
  origin?: string;
  sideEffectClass?: SideEffectClass;
  expiresAt?: string;
  maxActions?: number;
}

export interface VerificationEvidence {
  evidenceId: string;
  verifier: "lhic" | "external" | "omp" | "none";
  condition: string;
  result: "passed" | "failed" | "inconclusive" | "not_run";
  artifactHashes: string[];
  createdAt: string;
}

export interface SideEffectLedgerEntry {
  schemaVersion: "lhic-side-effect-ledger-v1";
  actionId: string;
  actionHash: string;
  taskId: string;
  surface: Surface;
  sideEffectClass: SideEffectClass;
  state: LedgerState;
  approvalScope?: ApprovalScope;
  idempotencyKey?: string;
  preconditionEvidenceIds: string[];
  postconditionEvidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentActionReceipt {
  schemaVersion: "lhic-action-receipt-v1";
  receiptId: string;
  actionId: string;
  taskId: string;
  surface: Surface;
  tool: string;
  sideEffectClass: SideEffectClass;
  plannerAuthority: Authority;
  approvalAuthority: Authority;
  executionAuthority: Authority;
  verificationAuthority: Authority;
  approvalScope?: ApprovalScope;
  ledgerState: LedgerState;
  evidence: VerificationEvidence[];
  createdAt: string;
  completedAt?: string;
}

export interface MemoryRecord {
  schemaVersion: "lhic-memory-v1";
  id: string;
  namespace: "verified_skill" | "selector" | "coding_context" | "user_fact" | "recipe_candidate";
  trust: "verifier_backed" | "observed" | "model_extracted" | "user_provided" | "shared_signed";
  sourceReceiptIds: string[];
  contentHash: string;
  staleAfter?: string;
  codeAnchor?: {
    repoId: string;
    commit?: string;
    paths: string[];
    pathHashes: Record<string, string>;
    symbols?: string[];
  };
}

export function mayPromoteToFastPath(record: MemoryRecord): boolean {
  return record.namespace === "verified_skill" &&
    (record.trust === "verifier_backed" || record.trust === "shared_signed");
}

export function mustNotBlindlyRetry(entry: SideEffectLedgerEntry): boolean {
  return entry.state === "dispatching" || entry.state === "possibly_committed" || entry.state === "executed";
}
