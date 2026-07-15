import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { RiskLevel, TraceEvent } from "@lhic/schema";
import { appendTraceEvent, redactPII } from "@lhic/trace";
import type { Page } from "playwright";

import type { VerifierEngine } from "@lhic/verifier";

export interface SkillContext {
  page: Page;
  verifier: VerifierEngine;
  taskId?: string;
  traceFilePath?: string;
}

export interface SkillResult {
  success: boolean;
  evidence: string[];
  traces: TraceEvent[];
  askUser?: boolean;
  error?: string;
}

export interface SkillTrace {
  readonly events: TraceEvent[];
  emit(
    type: string,
    payload: Record<string, unknown>,
    riskLevel?: RiskLevel,
  ): Promise<void>;
}

export function createSkillTrace(context: SkillContext): SkillTrace {
  const events: TraceEvent[] = [];
  const taskId = context.taskId ?? "skill-session";
  const traceFilePath =
    context.traceFilePath ?? join("traces", `${taskId}.jsonl`);

  return {
    events,
    async emit(type, payload, riskLevel) {
      const event = redactPII({
        eventId: randomUUID(),
        taskId,
        timestamp: new Date().toISOString(),
        type,
        payload,
        ...(riskLevel ? { riskLevel } : {}),
      }) as TraceEvent;
      events.push(event);
      await appendTraceEvent(traceFilePath, event);
    },
  };
}

export function skillFailure(
  trace: SkillTrace,
  error: string,
  askUser = false,
): SkillResult {
  return {
    success: false,
    evidence: [],
    traces: trace.events,
    ...(askUser ? { askUser } : {}),
    error,
  };
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
