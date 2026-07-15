import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendTraceEvent,
  hashState,
  readTraceEvents,
  redactPII,
  summarizeTraceEvents,
} from "./index.js";

describe("trace redaction and event log", () => {
  it("masks PII and secret-bearing properties", () => {
    const redacted = redactPII({
      email: "person@example.com",
      phone: "+1 (555) 123-4567",
      password: "do-not-log-me",
      token: "sk_12345678901234567890",
      action: { target: "#password", value: "also-do-not-log" },
      message: "Contact person@example.com with Bearer tok_abcdefghijklmnop",
    });

    expect(JSON.stringify(redacted)).not.toContain("person@example.com");
    expect(JSON.stringify(redacted)).not.toContain("do-not-log-me");
    expect(JSON.stringify(redacted)).not.toContain("123-4567");
    expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(redacted)).not.toContain("also-do-not-log");
  });

  it("appends and restores redacted JSONL trace events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-trace-"));
    const filePath = join(directory, "events.jsonl");

    try {
      await appendTraceEvent(filePath, {
        eventId: "event-1",
        taskId: "task-1",
        timestamp: "2026-07-15T00:00:00.000Z",
        type: "form_filled",
        payload: { email: "person@example.com", password: "not-for-disk" },
        riskLevel: "low",
      });

      const raw = await readFile(filePath, "utf8");
      const events = await readTraceEvents(filePath);
      expect(raw).not.toContain("person@example.com");
      expect(raw).not.toContain("not-for-disk");
      expect(events).toHaveLength(1);
      expect(events[0]?.payload).toEqual({
        email: "[REDACTED_EMAIL]",
        password: "[REDACTED]",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("hashes equivalent object states consistently", () => {
    expect(hashState({ b: 2, a: 1 })).toBe(hashState({ a: 1, b: 2 }));
    expect(hashState(undefined)).toHaveLength(64);
  });

  it("summarizes action reliability and incomplete work from traces", () => {
    const summary = summarizeTraceEvents([
      {
        eventId: "1",
        taskId: "task",
        timestamp: "2026-07-15T00:00:00.000Z",
        type: "action_started",
        payload: {},
        riskLevel: "low",
      },
      {
        eventId: "2",
        taskId: "task",
        timestamp: "2026-07-15T00:00:01.000Z",
        type: "action_completed",
        payload: {},
        riskLevel: "low",
      },
      {
        eventId: "3",
        taskId: "task",
        timestamp: "2026-07-15T00:00:02.000Z",
        type: "action_started",
        payload: {},
        riskLevel: "high",
      },
    ]);

    expect(summary).toMatchObject({
      eventCount: 3,
      actionSuccessRate: 1,
      incompleteActions: 1,
      eventsByRisk: { low: 2, high: 1 },
    });
  });
});
