import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  isAgentActionReceipt,
  type AgentActionReceipt,
  type TraceEvent,
} from "@lhic/schema";

import { appendTraceEvent, readTraceEvents } from "./event-log.js";
import { redactPII } from "./redact.js";

/**
 * Durable, append-only receipt log. Receipts are persisted as
 * `action_receipt` trace events (redacted, mode 0600). `appendReceipt` is
 * idempotent per receipt ID: restarting a supervisor must not duplicate
 * terminal receipts.
 */
export async function appendReceipt(
  filePath: string,
  receipt: AgentActionReceipt,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const existing = await readReceipts(filePath);
  if (existing.some((candidate) => candidate.receiptId === receipt.receiptId)) {
    return; // Idempotent: never duplicate a terminal receipt after restart.
  }
  const event: TraceEvent = {
    eventId: randomUUID(),
    taskId: receipt.taskId,
    timestamp: receipt.startedAt,
    type: "action_receipt",
    payload: { receipt },
  };
  await appendTraceEvent(filePath, event);
}

export async function readReceipts(
  filePath: string,
): Promise<AgentActionReceipt[]> {
  const events = await readTraceEvents(filePath);
  return events
    .filter((event) => event.type === "action_receipt")
    .map((event) => event.payload.receipt as unknown)
    .filter(isAgentActionReceipt);
}

/**
 * Receipts in stable lifecycle order: proposed/approved/dispatching/
 * possibly_committed/executed/verifying before verified/failed/needs_
 * resolution/rolled_back, then by startedAt.
 */
export function receiptTimeline(
  receipts: AgentActionReceipt[],
): AgentActionReceipt[] {
  const rank: Record<string, number> = {
    proposed: 0,
    policy_evaluated: 1,
    approved: 2,
    denied: 2,
    dispatching: 3,
    possibly_committed: 4,
    executed: 5,
    verifying: 6,
    verified: 7,
    failed: 7,
    needs_resolution: 7,
    rolled_back: 7,
  };
  return [...receipts].sort((left, right) => {
    const byState = (rank[left.state] ?? 8) - (rank[right.state] ?? 8);
    if (byState !== 0) return byState;
    return left.startedAt.localeCompare(right.startedAt);
  });
}

/** Persists receipts for one task as a standalone JSONL store (diagnostics). */
export async function writeReceiptBundle(
  filePath: string,
  receipts: AgentActionReceipt[],
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const redacted = receipts.map(
    (receipt) => redactPII(receipt) as AgentActionReceipt,
  );
  await writeFile(
    filePath,
    `${redacted.map((receipt) => JSON.stringify(receipt)).join("\n")}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export async function readReceiptBundle(
  filePath: string,
): Promise<AgentActionReceipt[]> {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isAgentActionReceipt);
  } catch (error) {
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

/** Default receipt log path inside a trace directory. */
export function receiptLogPath(traceDirectory: string, taskId: string): string {
  return join(traceDirectory, "receipts", `${taskId}.jsonl`);
}
