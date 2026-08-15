import type {
  ApprovalRecord,
  ApprovalScope,
  ResearchAction,
  SideEffectClass,
} from "./model.ts";
import { isHighRiskSideEffectClass } from "./policy.ts";

export interface ApprovalContext {
  now: Date;
  resolvedOrigin?: string;
  usageCount?: number;
}

function notExpired(expiresAt: string, now: Date): boolean {
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t > now.getTime();
}

function originMatches(scopeOrigin: string, resolvedOrigin: string): boolean {
  try {
    const allowed = new URL(scopeOrigin);
    const actual = new URL(resolvedOrigin);
    return allowed.protocol === actual.protocol && allowed.host === actual.host;
  } catch {
    return false;
  }
}

/** Academic reference validator for narrow approval scopes. */
export function approvalAllows(
  approval: ApprovalRecord | undefined,
  action: ResearchAction,
  effectiveClass: SideEffectClass,
  context: ApprovalContext,
): { allowed: boolean; reason: string } {
  if (!approval) {
    return effectiveClass === "read"
      ? { allowed: true, reason: "Read-only action does not require approval in this reference policy." }
      : { allowed: false, reason: "No approval was supplied for a side effect." };
  }

  const scope: ApprovalScope = approval.scope;
  if (!notExpired(scope.expiresAt, context.now)) {
    return { allowed: false, reason: "Approval scope expired." };
  }

  if (
    isHighRiskSideEffectClass(effectiveClass) &&
    (scope.type === "task_readonly" || scope.type === "origin_action_class")
  ) {
    return { allowed: false, reason: "High-risk actions require action-bound approval." };
  }

  switch (scope.type) {
    case "exact_action":
      return scope.actionHash === action.actionHash
        ? { allowed: true, reason: "Exact action hash matches." }
        : { allowed: false, reason: "Exact action hash mismatch." };
    case "plan_step":
      return scope.actionHash === action.actionHash
        ? { allowed: true, reason: "Plan-step action hash matches." }
        : { allowed: false, reason: "Plan-step action hash mismatch." };
    case "task_readonly":
      if (scope.taskId !== action.taskId) {
        return { allowed: false, reason: "Approval belongs to another task." };
      }
      return effectiveClass === "read"
        ? { allowed: true, reason: "Read-only task scope matches." }
        : { allowed: false, reason: "Read-only scope cannot authorize mutation." };
    case "origin_action_class": {
      if (scope.sideEffectClass !== effectiveClass) {
        return { allowed: false, reason: "Side-effect class does not match reusable scope." };
      }
      if (!context.resolvedOrigin || !originMatches(scope.origin, context.resolvedOrigin)) {
        return { allowed: false, reason: "Resolved origin does not match scope." };
      }
      if ((context.usageCount ?? 0) >= scope.maxActions) {
        return { allowed: false, reason: "Reusable approval action budget exhausted." };
      }
      return { allowed: true, reason: "Origin/class scope matches." };
    }
  }
}
