import { type ReceiptState } from "./receipt.js";
import { isSideEffectClass, type SideEffectClass } from "./receipt.js";

export const ledgerStates = [
  "proposed",
  "approved",
  "dispatching",
  "possibly_committed",
  "executed",
  "verified",
  "failed",
  "needs_resolution",
  "rolled_back",
] as const;

export type LedgerState = (typeof ledgerStates)[number];

/**
 * Durable side-effect ledger entry. `possibly_committed` is written BEFORE
 * the physical dispatch; on recovery it means "the side effect may have
 * happened" and requires re-observation, never blind replay. `verified`
 * entries are never repeated.
 */
export interface SideEffectLedgerEntry {
  schemaVersion: "lhic-side-effect-ledger-v1";
  actionId: string;
  actionHash: string;
  taskId: string;
  surface: "browser" | "desktop" | "network" | "control_plane";
  sideEffectClass: SideEffectClass;
  state: LedgerState;
  approvalExpiresAt?: string;
  idempotencyKey?: string;
  preconditionEvidenceRefs?: string[];
  verifierEvidenceRefs?: string[];
  createdAt: string;
  updatedAt: string;
}

export function isLedgerState(value: unknown): value is LedgerState {
  return (
    typeof value === "string" &&
    (ledgerStates as readonly string[]).includes(value)
  );
}

export function isSideEffectLedgerEntry(
  value: unknown,
): value is SideEffectLedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.schemaVersion !== "lhic-side-effect-ledger-v1") return false;
  if (typeof entry.actionId !== "string" || !entry.actionId.trim())
    return false;
  if (
    typeof entry.actionHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(entry.actionHash)
  ) {
    return false;
  }
  if (typeof entry.taskId !== "string" || !entry.taskId.trim()) return false;
  if (
    !["browser", "desktop", "network", "control_plane"].includes(
      String(entry.surface),
    )
  ) {
    return false;
  }
  if (!isSideEffectClass(entry.sideEffectClass)) return false;
  if (!isLedgerState(entry.state)) return false;
  if (
    typeof entry.createdAt !== "string" ||
    !Number.isFinite(Date.parse(entry.createdAt)) ||
    typeof entry.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.updatedAt))
  ) {
    return false;
  }
  if (
    entry.approvalExpiresAt !== undefined &&
    (typeof entry.approvalExpiresAt !== "string" ||
      !Number.isFinite(Date.parse(entry.approvalExpiresAt)))
  ) {
    return false;
  }
  return true;
}

/** Receipt states and ledger states stay in lockstep; this is the mapping. */
export function ledgerStateFromReceipt(
  state: ReceiptState,
): LedgerState | undefined {
  if (state === "policy_evaluated") return "proposed";
  if (state === "verifying") return "executed";
  // Denied actions never enter the durable side-effect ledger.
  if (state === "denied") return undefined;
  return state;
}
