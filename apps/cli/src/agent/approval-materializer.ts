import type { KeyLike } from "node:crypto";

import type { SemanticAction } from "@lhic/schema";
import {
  createActionApproval,
  validateActionApproval,
  type ActionApproval,
} from "@lhic/security";

export interface ApprovalMaterializerDecision {
  approvedBy: string;
  approval?: ActionApproval;
}

/**
 * Converts one human decision into an approval bound to the exact pending
 * action. Production accepts only a valid externally signed approval; local
 * interactive/auto decisions receive a short-lived action-hash approval.
 */
export function materializeActionApproval(
  action: SemanticAction,
  decision: ApprovalMaterializerDecision,
  options: {
    production: boolean;
    publicKey?: KeyLike;
    now?: Date;
  },
): ActionApproval {
  const now = options.now ?? new Date();
  if (options.production && !decision.approval) {
    throw new Error(
      "A fully signed external approval is required for production actions.",
    );
  }
  const approval =
    decision.approval ??
    createActionApproval(action, decision.approvedBy, {
      now,
      expiresInMs: 5 * 60_000,
    });
  const validation = validateActionApproval(action, approval, now, {
    forceConfirmation: true,
    confirmationReason: "CLI computer actions require exact-action approval.",
    requireSignature: options.production,
    ...(options.publicKey ? { publicKey: options.publicKey } : {}),
  });
  if (!validation.allowed) {
    throw new Error(validation.reason);
  }
  return approval;
}
