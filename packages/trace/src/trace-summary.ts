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
  /** Action receipts grouped by terminal state (verified/failed/other). */
  receiptCount: number;
  verifiedActions: number;
  failedActions: number;
  ambiguousActions: number;
}

export function summarizeTraceEvents(events: TraceEvent[]): TraceSummary {
  const eventsByType: Record<string, number> = {};
  const eventsByRisk: Record<string, number> = {};
  let actionStarted = 0;
  let actionCompleted = 0;
  let actionFailed = 0;
  let receiptCount = 0;
  let verifiedActions = 0;
  let failedActions = 0;
  let ambiguousActions = 0;

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
    } else if (event.type === "action_receipt") {
      receiptCount += 1;
      const state = (event.payload.receipt as { state?: string } | undefined)
        ?.state;
      if (state === "verified") verifiedActions += 1;
      else if (state === "failed") failedActions += 1;
      else if (state === "possibly_committed" || state === "needs_resolution") {
        ambiguousActions += 1;
      }
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
    receiptCount,
    verifiedActions,
    failedActions,
    ambiguousActions,
  };
}
