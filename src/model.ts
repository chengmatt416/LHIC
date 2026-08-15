/**
 * LHIC-Core academic data model.
 *
 * This is a deliberately small, product-independent extraction of the
 * execution semantics used by the full LHIC system. It is intended for
 * artifact evaluation, formal discussion, ablations, and failure injection.
 */

export const sideEffectClasses = [
  "read",
  "local_edit",
  "local_execute",
  "download",
  "upload",
  "external_write",
  "message_send",
  "account_change",
  "purchase",
  "financial_transfer",
  "credential_change",
  "destructive",
  "admin_or_security_change",
  "unknown",
] as const;

export type SideEffectClass = (typeof sideEffectClasses)[number];

export type Surface =
  | "code"
  | "shell"
  | "browser"
  | "desktop"
  | "network"
  | "control_plane";

export type Authority = "planner" | "operator" | "lhic" | "external" | "none";

export type LedgerState =
  | "proposed"
  | "approved"
  | "possibly_committed"
  | "executed"
  | "verified"
  | "failed"
  | "needs_resolution"
  | "rolled_back";

export interface ResearchAction {
  actionId: string;
  taskId: string;
  surface: Surface;
  tool: string;
  intent: string;
  target?: string;
  origin?: string;
  actionHash: string;
  plannerSideEffectClass?: SideEffectClass;
}

export type ApprovalScope =
  | { type: "exact_action"; actionHash: string; expiresAt: string }
  | {
      type: "plan_step";
      planId: string;
      stepId: string;
      actionHash: string;
      expiresAt: string;
    }
  | { type: "task_readonly"; taskId: string; expiresAt: string }
  | {
      type: "origin_action_class";
      origin: string;
      sideEffectClass: SideEffectClass;
      expiresAt: string;
      maxActions: number;
    };

export interface ApprovalRecord {
  approvalId: string;
  approvedBy: string;
  authority: "operator" | "lhic";
  scope: ApprovalScope;
  createdAt: string;
}

export interface VerificationEvidence {
  evidenceId: string;
  verifier: "lhic" | "external";
  condition: string;
  result: "passed" | "failed" | "inconclusive";
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
  approvalId?: string;
  idempotencyKey?: string;
  evidenceIds: string[];
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
  plannerAuthority: "planner" | "external";
  approvalAuthority: "operator" | "lhic" | "none";
  executionAuthority: "lhic" | "external";
  verificationAuthority: "lhic" | "external" | "none";
  ledgerState: LedgerState;
  approvalScope?: ApprovalScope;
  evidence: VerificationEvidence[];
  failureReason?: string;
  createdAt: string;
  completedAt?: string;
}

export interface MemoryRecord {
  schemaVersion: "lhic-memory-v1";
  id: string;
  namespace:
    | "verified_skill"
    | "selector"
    | "coding_context"
    | "user_fact"
    | "recipe_candidate";
  trust:
    | "verifier_backed"
    | "observed"
    | "model_extracted"
    | "user_provided"
    | "shared_signed";
  sourceTaskIds: string[];
  sourceReceiptIds: string[];
  holdoutPassed: boolean;
  contentHash: string;
  codeAnchor?: {
    paths: string[];
    pathHashes: Record<string, string>;
  };
}

export type ObservationOutcome =
  | "effect_present"
  | "effect_absent"
  | "inconclusive";

export interface ExecutionResult {
  accepted: boolean;
  sideEffectOccurred: boolean;
  responseReceived: boolean;
  detail?: string;
}
