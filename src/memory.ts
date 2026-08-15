import type { AgentActionReceipt, MemoryRecord } from "./model.ts";

export interface PromotionEvidence {
  record: MemoryRecord;
  receipts: AgentActionReceipt[];
}

/**
 * Academic promotion rule: reusable behavior needs independent verified
 * support, not repeated success from one task identity.
 */
export function mayPromoteToTrustedSkill(input: PromotionEvidence): boolean {
  const { record, receipts } = input;
  if (record.namespace !== "verified_skill" && record.namespace !== "recipe_candidate") {
    return false;
  }
  if (!record.holdoutPassed) return false;
  if (record.trust !== "verifier_backed" && record.trust !== "shared_signed") {
    return false;
  }

  const verified = receipts.filter(
    (receipt) =>
      receipt.ledgerState === "verified" &&
      receipt.verificationAuthority !== "none" &&
      receipt.evidence.some((evidence) => evidence.result === "passed"),
  );
  const independentTasks = new Set(verified.map((receipt) => receipt.taskId));
  return independentTasks.size >= 3;
}

/** Returns true when any code anchor differs from its recorded hash. */
export function codeAnchorIsStale(
  record: MemoryRecord,
  currentPathHashes: Record<string, string>,
): boolean {
  if (!record.codeAnchor) return false;
  return record.codeAnchor.paths.some(
    (path) => currentPathHashes[path] !== record.codeAnchor?.pathHashes[path],
  );
}
