import {
  isGlobalComputerAction,
  type SemanticAction,
  type SideEffectClass,
} from "@lhic/schema";

import { isSideEffectActivationTarget } from "./risk-policy.js";

/**
 * Risk ordering for side-effect classes. A planner-supplied class may raise
 * the effective class, never lower it; `unknown` sits at the top so any
 * unclassifiable action is treated most conservatively.
 */
const classRiskRank: Record<SideEffectClass, number> = {
  read: 0,
  local_edit: 1,
  local_execute: 2,
  download: 3,
  upload: 4,
  external_write: 5,
  message_send: 6,
  account_change: 7,
  purchase: 8,
  financial_transfer: 9,
  credential_change: 10,
  destructive: 11,
  admin_or_security_change: 12,
  unknown: 13,
};

/** High-risk classes may never be covered by broad or reusable scopes. */
const highRiskSideEffectClasses: Partial<Record<SideEffectClass, true>> = {
  purchase: true,
  financial_transfer: true,
  credential_change: true,
  destructive: true,
  admin_or_security_change: true,
};

/** Durable contract: identifies classes barred from broad/reusable scopes. */
export function isHighRiskSideEffectClass(
  sideEffectClass: SideEffectClass,
): boolean {
  return highRiskSideEffectClasses[sideEffectClass] === true;
}

export function isReadOnlySideEffectClass(
  sideEffectClass: SideEffectClass,
): boolean {
  return sideEffectClass === "read";
}

const financialIntentPattern =
  /\b(pay|payment|purchase|buy|checkout|transfer|refund|donate|withdraw|deposit|subscription|billing)\b/i;
const credentialIntentPattern =
  /\b(password|credential|secret|token|api\s*key|2fa|mfa|otp|recovery\s*code)\b/i;
const destructiveIntentPattern =
  /\b(delete|remove|destroy|truncate|drop|wipe|overwrite|unlink|rm\s*-|terminate|kill)\b/i;
const adminIntentPattern =
  /\b(admin|administrator|privilege|escalat|sudo|root|policy\s*change|permission|role\s*change|firewall|allowlist|revoke\s*access)\b/i;
const sendIntentPattern =
  /\b(send|post|publish|email|message|dm|tweet|comment|reply)\b/i;
const uploadIntentPattern = /\b(upload|publish\s*file|push\s*to\s*remote)\b/i;

/**
 * Independently infers the side-effect class of an action from its type,
 * intent, resolved target, destination, and payload — never from the
 * planner's own label. Unknown/partial state fails closed to `unknown`.
 */
export function inferSideEffectClass(action: SemanticAction): SideEffectClass {
  if (isGlobalComputerAction(action)) {
    switch (action.type) {
      case "os_observe":
      case "os_screenshot":
        return classifyTextual(action.intent, "read");
      case "os_launch":
      case "os_focus":
      case "os_scroll":
      case "os_clipboard":
        return classifyTextual(action.intent, "local_execute");
      case "os_type":
      case "os_press":
      case "os_click":
        return classifyActivation(action.intent, action.target);
      default:
        return "unknown";
    }
  }
  switch (action.type) {
    case "navigate":
    case "wait":
    case "scroll":
    case "hover":
    case "screenshot":
    case "tab":
    case "multi_tab":
      return classifyTextual(action.intent, "read");
    case "download":
      return classifyTextual(action.intent, "download");
    case "upload":
      return classifyTextual(action.intent, "upload");
    case "fill":
    case "select":
    case "keyboard":
      return classifyFill(action);
    case "click":
    case "press":
      return classifyActivation(action.intent, action.target);
    case "drag":
      return classifyTextual(action.intent, "local_edit");
    case "custom":
      return "unknown";
    default:
      return "unknown";
  }
}

function classifyTextual(
  intent: string,
  fallback: SideEffectClass,
): SideEffectClass {
  const combined = intent.toLowerCase();
  if (destructiveIntentPattern.test(combined)) return "destructive";
  if (credentialIntentPattern.test(combined)) return "credential_change";
  if (adminIntentPattern.test(combined)) return "admin_or_security_change";
  if (financialIntentPattern.test(combined)) return "purchase";
  if (sendIntentPattern.test(combined)) return "message_send";
  if (uploadIntentPattern.test(combined)) return "upload";
  return fallback;
}

function classifyActivation(intent: string, target?: string): SideEffectClass {
  const combined = `${intent} ${target ?? ""}`.toLowerCase();
  if (financialIntentPattern.test(combined)) return "purchase";
  if (destructiveIntentPattern.test(combined)) return "destructive";
  if (credentialIntentPattern.test(combined)) return "credential_change";
  if (adminIntentPattern.test(combined)) return "admin_or_security_change";
  if (target && isSideEffectActivationTarget(target)) {
    return "external_write";
  }
  if (sendIntentPattern.test(combined)) return "message_send";
  return "local_edit";
}

function classifyFill(action: SemanticAction): SideEffectClass {
  if (!isGlobalComputerAction(action)) {
    const combined = `${action.intent} ${action.target ?? ""}`.toLowerCase();
    if (credentialIntentPattern.test(combined)) return "credential_change";
    if (financialIntentPattern.test(combined)) return "purchase";
    if (destructiveIntentPattern.test(combined)) return "destructive";
    if (adminIntentPattern.test(combined)) return "admin_or_security_change";
  }
  return "local_edit";
}

/**
 * Effective class for a proposed action: the planner's class may raise the
 * independently inferred class, never lower it. A planner label of `read`
 * for a purchase/destructive action is escalated by the inference.
 */
export function effectiveSideEffectClass(
  plannerProposed: SideEffectClass | undefined,
  inferred: SideEffectClass,
): SideEffectClass {
  if (plannerProposed === undefined) return inferred;
  return classRiskRank[plannerProposed] > classRiskRank[inferred]
    ? plannerProposed
    : inferred;
}
