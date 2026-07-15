import type { RiskLevel } from "./risk.js";

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
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.taskId === "string" &&
    typeof candidate.timestamp === "string" &&
    typeof candidate.type === "string" &&
    !!candidate.payload &&
    typeof candidate.payload === "object"
  );
}
