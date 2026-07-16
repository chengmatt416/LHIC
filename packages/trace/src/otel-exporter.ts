import type { TraceEvent } from "@lhic/schema";

export interface OTelSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTime: string;
  endTime: string;
  attributes: Record<string, string | number | boolean>;
}

export class OTelExporter {
  public constructor(
    private readonly endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      "http://localhost:4318/v1/traces",
  ) {}

  /**
   * Maps LHIC TraceEvents to standard OTel structured spans and exports them.
   */
  public async exportTrace(
    taskId: string,
    events: TraceEvent[],
  ): Promise<OTelSpan[]> {
    const spans: OTelSpan[] = [];

    for (const event of events) {
      spans.push({
        traceId: taskId,
        spanId: event.eventId,
        name: event.type,
        startTime: event.timestamp,
        endTime: event.timestamp,
        attributes: {
          "lhic.task.id": taskId,
          "lhic.event.type": event.type,
          "lhic.risk.level": event.riskLevel || "low",
          "lhic.payload": JSON.stringify(event.payload || {}),
        },
      });
    }

    if (process.env.LHIC_ENV === "production") {
      try {
        await fetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            resourceSpans: [{ scopeSpans: [{ spans }] }],
          }),
        });
      } catch {
        // Silent fail to ensure APM errors don't crash automation
      }
    }

    return spans;
  }
}
