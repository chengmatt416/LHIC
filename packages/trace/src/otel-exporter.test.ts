import { describe, expect, it } from "vitest";
import { OTelExporter } from "./otel-exporter.js";

describe("OTelExporter", () => {
  it("successfully maps LHIC TraceEvents to standard OTel structured spans", async () => {
    const exporter = new OTelExporter();
    const events = [
      {
        eventId: "event-1",
        taskId: "task-999",
        type: "click",
        timestamp: new Date().toISOString(),
        riskLevel: "low" as const,
        payload: { target: "#btn" },
      },
    ];

    const spans = await exporter.exportTrace("task-999", events);
    expect(spans).toHaveLength(1);
    const firstSpan = spans[0];
    expect(firstSpan).toBeDefined();
    expect(firstSpan?.traceId).toBe("task-999");
    expect(firstSpan?.spanId).toBe("event-1");
    expect(firstSpan?.name).toBe("click");
    expect(firstSpan?.attributes["lhic.risk.level"]).toBe("low");
  });
});
