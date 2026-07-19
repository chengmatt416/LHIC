import { randomUUID, sign, verify, type KeyLike } from "node:crypto";

import type { SemanticAction } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { evaluateRisk, type RiskDecision } from "./risk-policy.js";

const maximumApprovalLifetimeMs = 5 * 60 * 1_000;
const maximumApprovalClockSkewMs = 30_000;

export interface ActionApproval {
  approvalId: string;
  actionHash: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  signature?: string;
}

export interface ActionApprovalValidationOptions {
  publicKey?: KeyLike;
  requireSignature?: boolean;
  forceConfirmation?: boolean;
  confirmationReason?: string;
  kmsKeyId?: string;
}

export interface ApprovalDecision extends RiskDecision {
  approvalId?: string;
}

export function createActionApproval(
  action: SemanticAction,
  approvedBy: string,
  options: { now?: Date; expiresInMs?: number } = {},
): ActionApproval {
  const now = options.now ?? new Date();
  const expiresInMs = options.expiresInMs ?? 5 * 60 * 1_000;
  if (!approvedBy.trim()) {
    throw new Error("Action approvals require an approver identifier.");
  }
  if (
    !Number.isSafeInteger(expiresInMs) ||
    expiresInMs < 1 ||
    expiresInMs > maximumApprovalLifetimeMs
  ) {
    throw new Error("Action approvals may last from 1ms through five minutes.");
  }

  return {
    approvalId: randomUUID(),
    actionHash: hashState(action),
    approvedBy: approvedBy.trim(),
    approvedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
  };
}

export function signActionApproval(
  approval: ActionApproval,
  privateKey: KeyLike,
): ActionApproval {
  return {
    ...approval,
    signature: sign(
      null,
      Buffer.from(approvalSignaturePayload(approval)),
      privateKey,
    ).toString("base64"),
  };
}

export function validateActionApproval(
  action: SemanticAction,
  approval: ActionApproval | undefined,
  now = new Date(),
  options: ActionApprovalValidationOptions = {},
): ApprovalDecision {
  const policy = evaluateRisk(action);
  const requiresConfirmation =
    policy.requiresConfirmation || options.forceConfirmation;
  const confirmationReason = options.confirmationReason ?? policy.reason;
  if (!requiresConfirmation) {
    return policy;
  }
  if (!approval) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: `${confirmationReason} No action approval was supplied.`,
    };
  }
  if (!approval.approvalId.trim()) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval is missing an approval identifier.",
    };
  }
  if (!approval.approvedBy.trim()) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval is missing an approver identifier.",
    };
  }
  if (approval.actionHash !== hashState(action)) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval does not match the requested action.",
    };
  }
  const approvedAt = parseApprovalTimestamp(approval.approvedAt);
  const expiresAt = parseApprovalTimestamp(approval.expiresAt);
  if (approvedAt === undefined || expiresAt === undefined) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval contains invalid timestamps.",
    };
  }
  if (approvedAt > now.getTime() + maximumApprovalClockSkewMs) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval is not valid yet.",
    };
  }
  if (expiresAt <= approvedAt) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval expiry must be after its approval time.",
    };
  }
  if (expiresAt - approvedAt > maximumApprovalLifetimeMs) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval lifetime exceeds five minutes.",
    };
  }
  if (expiresAt <= now.getTime()) {
    return {
      allowed: false,
      requiresConfirmation: true,
      reason: "Action approval has expired.",
    };
  }

  if (options.requireSignature) {
    let verificationKey = options.publicKey;
    if (!verificationKey && options.kmsKeyId) {
      // A configured local KMS key is resolved without persisting key material.
      const envVarName = `LHIC_KMS_KEY_${options.kmsKeyId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`;
      const fetchedKey =
        process.env[envVarName] || process.env.LHIC_KMS_DEFAULT_PUBLIC_KEY;
      if (fetchedKey) {
        verificationKey = fetchedKey;
      }
    }

    if (!verificationKey) {
      return {
        allowed: false,
        requiresConfirmation: true,
        reason:
          "Production high-risk actions require an approval verification public key or a valid KMS Key ID.",
      };
    }
    if (!approval.signature || !isValidSignature(approval, verificationKey)) {
      return {
        allowed: false,
        requiresConfirmation: true,
        reason: "Action approval signature is missing or invalid.",
      };
    }
  }

  return {
    allowed: true,
    requiresConfirmation: false,
    reason: options.forceConfirmation
      ? "The resolved target has a valid, matching human approval."
      : "High-risk action has a valid, matching human approval.",
    approvalId: approval.approvalId,
  };
}

function approvalSignaturePayload(approval: ActionApproval): string {
  return JSON.stringify({
    approvalId: approval.approvalId,
    actionHash: approval.actionHash,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    expiresAt: approval.expiresAt,
  });
}

function isValidSignature(
  approval: ActionApproval,
  publicKey: KeyLike,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(approvalSignaturePayload(approval)),
      publicKey,
      Buffer.from(approval.signature ?? "", "base64"),
    );
  } catch {
    return false;
  }
}

function parseApprovalTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp).toISOString() === value ? timestamp : undefined;
}
