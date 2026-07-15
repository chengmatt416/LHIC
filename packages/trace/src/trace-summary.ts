import type { TraceEvent } from "@lhic/schema";

export interface TraceSummary {
  eventCount: number;
  eventsByType: Record<string, number>;
  eventsByRisk: Record<string, number>;
  actionStarted: number;
  actionCompleted: number;
  actionFailed: number;
  actionSuccessRate: number | null;
  incompleteActions: number;
}

export function summarizeTraceEvents(events: TraceEvent[]): TraceSummary {
  const eventsByType: Record<string, number> = {};
  const eventsByRisk: Record<string, number> = {};
  let actionStarted = 0;
  let actionCompleted = 0;
  let actionFailed = 0;

  for (const event of events) {
    eventsByType[event.type] = (eventsByType[event.type] ?? 0) + 1;
    if (event.riskLevel) {
      eventsByRisk[event.riskLevel] = (eventsByRisk[event.riskLevel] ?? 0) + 1;
    }
    if (event.type === "action_started") {
      actionStarted += 1;
    } else if (event.type === "action_completed") {
      actionCompleted += 1;
    } else if (event.type === "action_failed") {
      actionFailed += 1;
    }
  }

  const completedOrFailed = actionCompleted + actionFailed;
  return {
    eventCount: events.length,
    eventsByType,
    eventsByRisk,
    actionStarted,
    actionCompleted,
    actionFailed,
    actionSuccessRate:
      completedOrFailed === 0 ? null : actionCompleted / completedOrFailed,
    incompleteActions: Math.max(0, actionStarted - completedOrFailed),
  };
}
