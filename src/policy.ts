import type { ResearchAction, SideEffectClass } from "./model.ts";

const riskRank: Record<SideEffectClass, number> = {
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

const highRisk = new Set<SideEffectClass>([
  "purchase",
  "financial_transfer",
  "credential_change",
  "destructive",
  "admin_or_security_change",
]);

const patterns: Array<[RegExp, SideEffectClass]> = [
  [/\b(transfer|wire|withdraw|deposit)\b/i, "financial_transfer"],
  [/\b(buy|purchase|checkout|pay|payment|subscription)\b/i, "purchase"],
  [/\b(password|credential|api\s*key|token|2fa|mfa|recovery\s*code)\b/i, "credential_change"],
  [/\b(delete|drop|wipe|destroy|truncate|rm\s+-|terminate)\b/i, "destructive"],
  [/\b(admin|sudo|root|permission|role\s*change|firewall|security\s*policy)\b/i, "admin_or_security_change"],
  [/\b(send|post|publish|email|message|reply|comment)\b/i, "message_send"],
  [/\b(upload|push\s+to\s+remote)\b/i, "upload"],
];

/**
 * Conservative research classifier. It intentionally demonstrates the
 * invariant rather than reproducing every product-specific UI heuristic.
 */
export function inferSideEffectClass(action: ResearchAction): SideEffectClass {
  const text = `${action.intent} ${action.target ?? ""}`;
  for (const [pattern, klass] of patterns) {
    if (pattern.test(text)) return klass;
  }

  switch (action.surface) {
    case "browser":
    case "desktop":
      return action.tool.includes("observe") || action.tool.includes("screenshot")
        ? "read"
        : "local_edit";
    case "code":
      return action.tool.includes("read") ? "read" : "local_edit";
    case "shell":
      return "local_execute";
    case "network":
    case "control_plane":
      return "external_write";
    default:
      return "unknown";
  }
}

/** Planner classification may increase risk, never lower runtime-inferred risk. */
export function effectiveSideEffectClass(
  planner: SideEffectClass | undefined,
  inferred: SideEffectClass,
): SideEffectClass {
  if (!planner) return inferred;
  return riskRank[planner] > riskRank[inferred] ? planner : inferred;
}

export function isHighRiskSideEffectClass(klass: SideEffectClass): boolean {
  return highRisk.has(klass);
}
