import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  appendStageRouteEvent,
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

  it("redacts password-targeted browser form-fill values before persistence", () => {
    const redacted = redactPII({
      action: {
        type: "fill",
        target: 'input[type="password"]',
        value: "credential-that-must-not-persist",
      },
    });

    expect(JSON.stringify(redacted)).not.toContain(
      "credential-that-must-not-persist",
    );
    expect(redacted).toEqual({
      action: {
        type: "fill",
        target: 'input[type="password"]',
        value: "[REDACTED]",
      },
    });
  });

  it("redacts credentials and sensitive parameters embedded in URLs", () => {
    const source =
      "Navigation failed at https://person:credential@example.test/path?access_token=secret-token&query=safe#api_key=fragment-secret";
    const redacted = redactPII({ action: { target: source } });

    expect(JSON.stringify(redacted)).not.toContain("person");
    expect(JSON.stringify(redacted)).not.toContain("credential");
    expect(JSON.stringify(redacted)).not.toContain("secret-token");
    expect(JSON.stringify(redacted)).not.toContain("fragment-secret");
    expect(JSON.stringify(redacted)).toContain("example.test");
    expect(JSON.stringify(redacted)).toContain("query=safe");
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

  it("restricts trace files and newly created directories to the service account", async () => {
    if (process.platform === "win32") return;

    const directory = await mkdtemp(join(tmpdir(), "lhic-trace-permissions-"));
    const traceDirectory = join(directory, "private-traces");
    const filePath = join(traceDirectory, "events.jsonl");
    try {
      await mkdir(traceDirectory, { recursive: true, mode: 0o755 });
      await chmod(traceDirectory, 0o755);
      await writeFile(filePath, "", { mode: 0o644 });
      await chmod(filePath, 0o644);

      await appendTraceEvent(filePath, {
        eventId: "event-permissions",
        taskId: "task-permissions",
        timestamp: "2026-07-19T00:00:00.000Z",
        type: "action_completed",
        payload: {},
        riskLevel: "low",
      });

      expect((await stat(traceDirectory)).mode & 0o777).toBe(0o755);
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);

      const nestedFilePath = join(traceDirectory, "nested", "events.jsonl");
      await appendTraceEvent(nestedFilePath, {
        eventId: "event-nested-permissions",
        taskId: "task-permissions",
        timestamp: "2026-07-19T00:00:00.000Z",
        type: "action_completed",
        payload: {},
        riskLevel: "low",
      });
      expect((await stat(join(traceDirectory, "nested"))).mode & 0o777).toBe(
        0o700,
      );
      expect((await stat(nestedFilePath)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses a symbolic-link trace file", async () => {
    if (process.platform === "win32") return;

    const directory = await mkdtemp(join(tmpdir(), "lhic-trace-link-"));
    const protectedFile = join(directory, "protected.jsonl");
    const traceLink = join(directory, "events.jsonl");
    try {
      await writeFile(protectedFile, "protected\n", "utf8");
      await symlink(protectedFile, traceLink);

      await expect(
        appendTraceEvent(traceLink, {
          eventId: "event-link",
          taskId: "task-link",
          timestamp: "2026-07-19T00:00:00.000Z",
          type: "action_completed",
          payload: {},
          riskLevel: "low",
        }),
      ).rejects.toThrow("symbolic links");
      expect(await readFile(protectedFile, "utf8")).toBe("protected\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("records route decisions and budgets without model inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-route-trace-"));
    const filePath = join(directory, "events.jsonl");
    try {
      await appendStageRouteEvent(
        filePath,
        "task-1",
        {
          stage: "recover",
          path: "slow_planner",
          reason: "Selector changed for person@example.com",
          confidence: 0.3,
          profile: "balanced",
          remainingBudget: {
            maxSlowPathCalls: 0,
            maxSlowPathInputChars: 11_900,
            maxImageInputs: 0,
            maxStages: 10,
            maxWallClockMs: 59_000,
          },
          fallbackFrom: "local_recovery",
        },
        {
          slowPathCalls: 1,
          slowPathInputChars: 100,
          imageInputs: 0,
          slowPathLatencyMs: 500,
          stages: 2,
          wallClockMs: 1_000,
        },
      );
      const raw = await readFile(filePath, "utf8");
      expect(raw).not.toContain("person@example.com");
      expect(await readTraceEvents(filePath)).toEqual([
        expect.objectContaining({ type: "stage_routed" }),
      ]);
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

  it("redacts sensitive data using local NER-like heuristics", () => {
    const redacted = redactPII({
      nameInfo: "Hello, my name is Alice Cooper",
      intro: "I am John Doe and I want to login as administrator",
      credentialAssigned: "password = super_secret_pass_12345",
      apiInfo: "key: my_personal_token_9999",
      orgInfo: "Acme Corp. is a great enterprise",
    });

    expect(JSON.stringify(redacted)).toContain("[REDACTED_NAME]");
    expect(JSON.stringify(redacted)).toContain("[REDACTED_SECRET]");
    expect(JSON.stringify(redacted)).toContain("[REDACTED_ORG]");
    expect(JSON.stringify(redacted)).not.toContain("Alice");
    expect(JSON.stringify(redacted)).not.toContain("John");
    expect(JSON.stringify(redacted)).not.toContain("super_secret_pass_12345");
    expect(JSON.stringify(redacted)).not.toContain("Acme Corp.");
  });
});
