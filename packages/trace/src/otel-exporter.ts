import type { TraceEvent } from "@lhic/schema";

export interface OTelSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, string | number | boolean>;
}

export class OTelExporter {
  private lastError: Error | undefined;

  public constructor(
    private readonly endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      "http://localhost:4318/v1/traces",
  ) {}

  public getLastError(): Error | undefined {
    return this.lastError;
  }

  /**
   * Maps LHIC TraceEvents to standard OTel structured spans and exports them.
   * Pairs action_started/action_completed events to compute durations.
   */
  public async exportTrace(
    taskId: string,
    events: TraceEvent[],
  ): Promise<OTelSpan[]> {
    const spans: OTelSpan[] = [];
    const pendingStarts = new Map<string, TraceEvent>();

    for (const event of events) {
      if (event.type === "action_started") {
        pendingStarts.set(event.eventId, event);
        continue;
      }

      const parentEvent =
        event.type === "action_completed" || event.type === "action_failed"
          ? pendingStarts.get(event.payload?.startEventId as string)
          : undefined;

      if (parentEvent) {
        pendingStarts.delete(parentEvent.eventId);
      }

      const span: OTelSpan = {
        traceId: taskId,
        spanId: event.eventId,
        parentSpanId: parentEvent?.eventId,
        name: event.type,
        startTime: parentEvent?.timestamp ?? event.timestamp,
        endTime: event.timestamp,
        attributes: {
          "lhic.task.id": taskId,
          "lhic.event.type": event.type,
          "lhic.risk.level": event.riskLevel ?? "low",
        },
      };

      if (event.type === "action_failed" && event.payload?.error) {
        span.attributes["lhic.error"] = String(event.payload.error);
      }
      spans.push(span);
    }

    // Emit remaining unpaired starts as instant spans
    for (const event of pendingStarts.values()) {
      spans.push({
        traceId: taskId,
        spanId: event.eventId,
        name: event.type,
        startTime: event.timestamp,
        endTime: event.timestamp,
        attributes: {
          "lhic.task.id": taskId,
          "lhic.event.type": event.type,
          "lhic.risk.level": event.riskLevel ?? "low",
        },
      });
    }

    if (process.env.LHIC_ENV === "production") {
      try {
        const response = await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceSpans: [{ scopeSpans: [{ spans }] }],
          }),
        });
        if (!response.ok) {
          this.lastError = new Error(
            `OTLP export failed: HTTP ${response.status}`,
          );
        }
      } catch (error: unknown) {
        this.lastError =
          error instanceof Error ? error : new Error(String(error));
      }
    }

    return spans;
  }
}
