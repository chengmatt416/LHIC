import { randomUUID, sign, verify, type KeyLike } from "node:crypto";

import {
  isApprovalScope,
  type ApprovalScope,
  type SideEffectClass,
  type SemanticAction,
} from "@lhic/schema";

import type { ActionApproval } from "./action-approval.js";
import {
  createActionApproval,
  validateActionApproval,
} from "./action-approval.js";
import { isHighRiskSideEffectClass } from "./side-effect-classification.js";

const maximumScopeLifetimeMs = 30 * 60 * 1_000;

/**
 * Canonical scope string stored in `ActionApproval.scope`. The scope JSON is
 * the canonical serialization; parsing rejects unknown scope shapes (fail
 * closed).
 */
export function approvalScopeString(scope: ApprovalScope): string {
  return JSON.stringify(scope);
}

export function parseApprovalScope(value: string): ApprovalScope | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isApprovalScope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface ApprovalScopeValidationOptions {
  now?: Date;
  /** Resolved destination origin for origin_action_class matching. */
  resolvedOrigin?: string;
  /** Effective side-effect class (already planner-escalated). */
  sideEffectClass: SideEffectClass;
  /** Actions already consumed for an origin_action_class scope. */
  usageCount?: number;
}

/**
 * Decides whether an approval's structured scope authorizes this action.
 * Base action-hash binding is checked first (callers use
 * `validateActionApproval` with `expectedScope` for that); this function
 * applies the scope's own semantics: hash binding, expiry, read-only
 * requirement, origin/class match, action-count budget, and the
 * high-risk-class exclusion. Unknown or malformed scope state fails closed.
 */
export function validateApprovalScope(
  scope: ApprovalScope | undefined,
  approval: ActionApproval,
  options: ApprovalScopeValidationOptions,
): { valid: boolean; reason?: string } {
  if (!scope) {
    return { valid: false, reason: "Approval carries no usable scope." };
  }
  const now = options.now ?? new Date();

  // The scope's action binding must match the approval's action hash binding.
  const scopeHash =
    scope.type === "exact_action"
      ? scope.actionHash
      : scope.type === "plan_step"
        ? scope.actionHash
        : undefined;
  if (scopeHash !== undefined && approval.actionHash !== scopeHash) {
    return {
      valid: false,
      reason: "Approval scope is bound to a different action hash.",
    };
  }
  if (scope.type === "task_readonly") {
    if (Date.parse(scope.expiresAt) <= now.getTime()) {
      return { valid: false, reason: "Read-only approval scope has expired." };
    }
    if (isHighRiskSideEffectClass(options.sideEffectClass)) {
      return {
        valid: false,
        reason: "A read-only scope cannot cover a high-risk side-effect class.",
      };
    }
    if (options.sideEffectClass !== "read") {
      return {
        valid: false,
        reason: `Read-only scope cannot cover side-effect class ${options.sideEffectClass}.`,
      };
    }
    return { valid: true };
  }
  if (scope.type === "origin_action_class") {
    if (Date.parse(scope.expiresAt) <= now.getTime()) {
      return {
        valid: false,
        reason: "Origin/action-class scope has expired.",
      };
    }
    if (isHighRiskSideEffectClass(scope.sideEffectClass)) {
      return {
        valid: false,
        reason: "High-risk side-effect classes cannot use a reusable scope.",
      };
    }
    if (scope.sideEffectClass !== options.sideEffectClass) {
      return {
        valid: false,
        reason: `Scope covers ${scope.sideEffectClass}, not ${options.sideEffectClass}.`,
      };
    }
    if (options.resolvedOrigin !== undefined) {
      const origin = String(options.resolvedOrigin).toLowerCase();
      if (!origin.startsWith(scope.origin.toLowerCase())) {
        return {
          valid: false,
          reason: `Resolved origin ${origin} is outside scope origin ${scope.origin}.`,
        };
      }
    }
    const used = options.usageCount ?? 0;
    if (used >= scope.maxActions) {
      return {
        valid: false,
        reason: "Approval scope action budget is exhausted.",
      };
    }
    return { valid: true };
  }
  // exact_action / plan_step: hash binding above is the whole check.
  return { valid: true };
}

export interface ScopedApprovalOptions {
  now?: Date;
  /** Scope expiry override (default 5 minutes for exact/plan, 30 for reusable). */
  expiresInMs?: number;
  approvedBy: string;
  scope: ApprovalScope;
  sideEffectClass: SideEffectClass;
}

export interface CombinedScopeValidationOptions {
  now?: Date;
  resolvedOrigin?: string;
  sideEffectClass: SideEffectClass;
  usageCount?: number;
  requireSignature?: boolean;
  publicKey?: KeyLike;
}

/**
 * Single fail-closed gate for scoped approvals: base approval validation
 * (hash binding, timestamps, signature) plus structured scope semantics
 * (expiry, read-only, origin/class, high-risk exclusion, action budget).
 * Executors must use this instead of `validateActionApproval` alone whenever
 * the approval may carry a structured scope.
 */
export function validateActionApprovalWithScopes(
  action: SemanticAction,
  approval: ActionApproval,
  options: CombinedScopeValidationOptions,
): { allowed: boolean; reason: string } {
  const scope = parseApprovalScope(approval.scope ?? "");
  const base = validateActionApproval(action, approval, options.now, {
    ...(options.requireSignature !== undefined
      ? { requireSignature: options.requireSignature }
      : {}),
    ...(options.publicKey ? { publicKey: options.publicKey } : {}),
    ...(scope ? { expectedScope: approvalScopeString(scope) } : {}),
    forceConfirmation: true,
  });
  if (!base.allowed) {
    return { allowed: false, reason: base.reason };
  }
  if (scope) {
    const scopeCheck = validateApprovalScope(scope, approval, {
      sideEffectClass: options.sideEffectClass,
      ...(options.now ? { now: options.now } : {}),
      ...(options.resolvedOrigin
        ? { resolvedOrigin: options.resolvedOrigin }
        : {}),
      ...(options.usageCount !== undefined
        ? { usageCount: options.usageCount }
        : {}),
    });
    if (!scopeCheck.valid) {
      return {
        allowed: false,
        reason: scopeCheck.reason ?? "Invalid approval scope.",
      };
    }
  }
  return { allowed: true, reason: base.reason };
}

/**
 * Creates an approval carrying a structured scope. High-risk classes are
 * refused for task_readonly and origin_action_class at creation time.
 */
export function createScopedApproval(
  action: SemanticAction,
  options: ScopedApprovalOptions,
): ActionApproval {
  if (
    (options.scope.type === "task_readonly" ||
      options.scope.type === "origin_action_class") &&
    isHighRiskSideEffectClass(options.sideEffectClass)
  ) {
    throw new Error(
      "High-risk side-effect classes cannot use task_readonly or origin_action_class scopes.",
    );
  }
  const defaultLifetimeMs =
    options.scope.type === "task_readonly" ||
    options.scope.type === "origin_action_class"
      ? maximumScopeLifetimeMs
      : 5 * 60 * 1_000;
  const expiresInMs = options.expiresInMs ?? defaultLifetimeMs;
  if (
    (options.scope.type === "task_readonly" ||
      options.scope.type === "origin_action_class") &&
    expiresInMs > maximumScopeLifetimeMs
  ) {
    throw new Error("Reusable approval scopes may last at most 30 minutes.");
  }
  return createActionApproval(action, options.approvedBy, {
    ...(options.now ? { now: options.now } : {}),
    expiresInMs,
    scope: approvalScopeString(options.scope),
  });
}
