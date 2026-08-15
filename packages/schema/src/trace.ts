import { isRiskLevel, type RiskLevel } from "./risk.js";

export const knownTraceEventTypes = [
  "action_started",
  "action_completed",
  "action_failed",
  "stage_routed",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "skill_candidate_recorded",
  "skill_promoted",
  "verification_completed",
  "task_started",
  "task_completed",
  "task_failed",
  "recovery_attempted",
  "slow_path_invoked",
  "browser_snapshot",
  "desktop_action",
  "action_receipt",
  "workspace_conflict",
  "side_effect_ledger",
] as const;

export type TraceEventType = (typeof knownTraceEventTypes)[number];

export interface TraceEvent {
  eventId: string;
  taskId: string;
  timestamp: string;
  type: string;
  payload: Record<string, unknown>;
  riskLevel?: RiskLevel;
}

export function isTraceEvent(value: unknown): value is TraceEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<TraceEvent>;
  if (typeof candidate.eventId !== "string" || !candidate.eventId.trim()) {
    return false;
  }
  if (typeof candidate.taskId !== "string" || !candidate.taskId.trim()) {
    return false;
  }
  if (
    typeof candidate.timestamp !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(candidate.timestamp) ||
    Number.isNaN(Date.parse(candidate.timestamp))
  ) {
    return false;
  }
  if (typeof candidate.type !== "string" || !candidate.type.trim()) {
    return false;
  }
  if (!candidate.payload || typeof candidate.payload !== "object") {
    return false;
  }
  if (candidate.riskLevel !== undefined && !isRiskLevel(candidate.riskLevel)) {
    return false;
  }
  return true;
}
