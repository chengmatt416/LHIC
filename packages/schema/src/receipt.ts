import type { SemanticAction } from "./action.js";

/**
 * Structured side-effect taxonomy. The planner may propose a class, but LHIC
 * independently infers the class from the action; planner-supplied
 * classification may raise risk, never lower it (see
 * `effectiveSideEffectClass` in @lhic/security).
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

/**
 * Narrow approval scopes. There is deliberately no "allow everything for this
 * session" scope for browser/desktop side effects. High-risk classes
 * (purchase, transfer, credential change, destructive, admin/security) can
 * never be covered by a task_readonly or origin_action_class scope.
 */
export type ApprovalScope =
  | { type: "exact_action"; actionHash: string }
  | { type: "plan_step"; planId: string; stepId: string; actionHash: string }
  | { type: "task_readonly"; taskId: string; expiresAt: string }
  | {
      type: "origin_action_class";
      origin: string;
      sideEffectClass: SideEffectClass;
      expiresAt: string;
      maxActions: number;
    };

/** Every fallback attempt in a semantic-targeting → native dispatch chain. */
export interface BackendAttemptEvidence {
  backend: string;
  observationId?: string;
  target: string;
  result:
    | "matched"
    | "no_match"
    | "ambiguous"
    | "stale"
    | "unsupported"
    | "dispatch_failed";
  confidence?: number;
  reason?: string;
  timestamp: string;
}

export const receiptStates = [
  "proposed",
  "policy_evaluated",
  "approved",
  "denied",
  "dispatching",
  "possibly_committed",
  "executed",
  "verifying",
  "verified",
  "failed",
  "needs_resolution",
  "rolled_back",
] as const;

export type ReceiptState = (typeof receiptStates)[number];

/**
 * One truthful, cross-surface audit record for an agent action. Authority is
 * explicit per phase: OMP-native success is execution evidence, never LHIC
 * verification, unless an LHIC/external verifier actually ran and its
 * evidence refs are attached.
 */
export interface AgentActionReceipt {
  schemaVersion: "lhic-action-receipt-v1";

  receiptId: string;
  actionId: string;
  taskId: string;
  sessionId?: string;
  turnId?: string;
  traceId?: string;

  surface:
    "code" | "shell" | "browser" | "desktop" | "network" | "control_plane";

  tool: string;
  intent?: string;

  proposedAction?: unknown;
  resolvedTarget?: unknown;

  sideEffectClass: SideEffectClass;
  inferredRisk: string;
  plannerRisk?: string;

  approval: {
    required: boolean;
    status: "not_required" | "pending" | "approved" | "denied" | "expired";
    authority: "omp" | "lhic" | "operator" | "none";
    scope?: ApprovalScope;
    actionHash?: string;
    approvedBy?: string;
    approvedAt?: string;
    expiresAt?: string;
  };

  planner: {
    authority: "omp" | "lhic" | "external";
    modelId?: string;
  };

  executor: {
    authority: "omp" | "lhic" | "external";
    backend?: string;
    fallbackChain?: BackendAttemptEvidence[];
  };

  verification: {
    authority: "lhic" | "external-verifier" | "omp" | "none";
    status: "not_run" | "passed" | "failed" | "inconclusive";
    evidenceRefs: string[];
  };

  state: ReceiptState;

  idempotencyKey?: string;
  dedupeKey?: string;

  preconditionEvidenceRefs?: string[];
  postconditionEvidenceRefs?: string[];
  artifactHashes?: string[];

  startedAt: string;
  completedAt?: string;
  failureReason?: string;
}

export function isSideEffectClass(value: unknown): value is SideEffectClass {
  return (
    typeof value === "string" &&
    (sideEffectClasses as readonly string[]).includes(value)
  );
}

export function isReceiptState(value: unknown): value is ReceiptState {
  return (
    typeof value === "string" &&
    (receiptStates as readonly string[]).includes(value)
  );
}

export function isApprovalScope(value: unknown): value is ApprovalScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Record<string, unknown>;
  switch (scope.type) {
    case "exact_action":
      return (
        typeof scope.actionHash === "string" &&
        /^[a-f0-9]{64}$/.test(scope.actionHash)
      );
    case "plan_step":
      return (
        typeof scope.planId === "string" &&
        scope.planId.length > 0 &&
        typeof scope.stepId === "string" &&
        scope.stepId.length > 0 &&
        typeof scope.actionHash === "string" &&
        /^[a-f0-9]{64}$/.test(scope.actionHash)
      );
    case "task_readonly":
      return (
        typeof scope.taskId === "string" &&
        scope.taskId.length > 0 &&
        typeof scope.expiresAt === "string" &&
        Number.isFinite(Date.parse(scope.expiresAt))
      );
    case "origin_action_class":
      return (
        typeof scope.origin === "string" &&
        scope.origin.length > 0 &&
        isSideEffectClass(scope.sideEffectClass) &&
        typeof scope.expiresAt === "string" &&
        Number.isFinite(Date.parse(scope.expiresAt)) &&
        typeof scope.maxActions === "number" &&
        Number.isSafeInteger(scope.maxActions) &&
        scope.maxActions > 0
      );
    default:
      return false;
  }
}

export function isBackendAttemptEvidence(
  value: unknown,
): value is BackendAttemptEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  if (
    typeof attempt.backend !== "string" ||
    attempt.backend.length === 0 ||
    typeof attempt.target !== "string" ||
    typeof attempt.timestamp !== "string" ||
    !Number.isFinite(Date.parse(attempt.timestamp)) ||
    ![
      "matched",
      "no_match",
      "ambiguous",
      "stale",
      "unsupported",
      "dispatch_failed",
    ].includes(String(attempt.result))
  ) {
    return false;
  }
  if (
    attempt.observationId !== undefined &&
    typeof attempt.observationId !== "string"
  ) {
    return false;
  }
  if (
    attempt.confidence !== undefined &&
    (typeof attempt.confidence !== "number" ||
      !Number.isFinite(attempt.confidence) ||
      attempt.confidence < 0 ||
      attempt.confidence > 1)
  ) {
    return false;
  }
  return attempt.reason === undefined || typeof attempt.reason === "string";
}

export function isAgentActionReceipt(
  value: unknown,
): value is AgentActionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.schemaVersion !== "lhic-action-receipt-v1") return false;
  if (typeof receipt.receiptId !== "string" || !receipt.receiptId.trim()) {
    return false;
  }
  if (typeof receipt.actionId !== "string" || !receipt.actionId.trim()) {
    return false;
  }
  if (typeof receipt.taskId !== "string" || !receipt.taskId.trim()) {
    return false;
  }
  if (
    ![
      "code",
      "shell",
      "browser",
      "desktop",
      "network",
      "control_plane",
    ].includes(String(receipt.surface))
  ) {
    return false;
  }
  if (typeof receipt.tool !== "string" || !receipt.tool.trim()) return false;
  if (!isSideEffectClass(receipt.sideEffectClass)) return false;
  if (typeof receipt.inferredRisk !== "string") return false;
  if (!isReceiptState(receipt.state)) return false;
  if (
    typeof receipt.startedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.startedAt))
  ) {
    return false;
  }
  if (
    receipt.completedAt !== undefined &&
    (typeof receipt.completedAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.completedAt)))
  ) {
    return false;
  }
  const approval = receipt.approval as Record<string, unknown> | undefined;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return false;
  }
  if (typeof approval.required !== "boolean") return false;
  if (
    !["not_required", "pending", "approved", "denied", "expired"].includes(
      String(approval.status),
    )
  ) {
    return false;
  }
  if (
    !["omp", "lhic", "operator", "none"].includes(String(approval.authority))
  ) {
    return false;
  }
  if (approval.scope !== undefined && !isApprovalScope(approval.scope)) {
    return false;
  }
  const planner = receipt.planner as Record<string, unknown> | undefined;
  if (
    !planner ||
    !["omp", "lhic", "external"].includes(String(planner.authority))
  ) {
    return false;
  }
  const executor = receipt.executor as Record<string, unknown> | undefined;
  if (
    !executor ||
    !["omp", "lhic", "external"].includes(String(executor.authority))
  ) {
    return false;
  }
  if (
    executor.fallbackChain !== undefined &&
    (!Array.isArray(executor.fallbackChain) ||
      !executor.fallbackChain.every(isBackendAttemptEvidence))
  ) {
    return false;
  }
  const verification = receipt.verification as
    Record<string, unknown> | undefined;
  if (!verification || typeof verification !== "object") return false;
  if (
    !["lhic", "external-verifier", "omp", "none"].includes(
      String(verification.authority),
    )
  ) {
    return false;
  }
  if (
    !["not_run", "passed", "failed", "inconclusive"].includes(
      String(verification.status),
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(verification.evidenceRefs) ||
    !verification.evidenceRefs.every((ref) => typeof ref === "string")
  ) {
    return false;
  }
  return true;
}
