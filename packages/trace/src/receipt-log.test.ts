import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentActionReceipt } from "@lhic/schema";

import {
  appendReceipt,
  readReceiptBundle,
  readReceipts,
  receiptLogPath,
  receiptTimeline,
  writeReceiptBundle,
} from "./receipt-log.js";

function receipt(
  state: AgentActionReceipt["state"],
  id: string,
): AgentActionReceipt {
  return {
    schemaVersion: "lhic-action-receipt-v1",
    receiptId: id,
    actionId: `action-${id}`,
    taskId: "task-1",
    surface: "browser",
    tool: "lhic_browser_execute",
    sideEffectClass: "external_write",
    inferredRisk: "medium",
    approval: { required: true, status: "approved", authority: "lhic" },
    planner: { authority: "omp", modelId: "provider/model" },
    executor: { authority: "lhic", backend: "playwright" },
    verification: {
      authority: "lhic",
      status: "passed",
      evidenceRefs: ["evidence:x"],
    },
    state,
    startedAt: "2026-08-14T00:00:00.000Z",
    completedAt: "2026-08-14T00:00:01.000Z",
  };
}

describe("receipt log", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-receipt-log-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("appends, reads, and dedupes receipts idempotently", async () => {
    const path = receiptLogPath(directory, "task-1");
    await appendReceipt(path, receipt("verified", "r1"));
    await appendReceipt(path, receipt("verified", "r1")); // restart duplicate
    const receipts = await readReceipts(path);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.receiptId).toBe("r1");
  });

  it("orders the timeline by lifecycle state", () => {
    const timeline = receiptTimeline([
      receipt("verified", "r3"),
      receipt("proposed", "r1"),
      receipt("dispatching", "r2"),
    ]);
    expect(timeline.map((entry) => entry.receiptId)).toEqual([
      "r1",
      "r2",
      "r3",
    ]);
  });

  it("persists a standalone redacted bundle", async () => {
    const path = join(directory, "bundle.jsonl");
    await writeReceiptBundle(path, [receipt("verified", "r1")]);
    expect(await readReceiptBundle(path)).toHaveLength(1);
    expect(await readReceiptBundle(join(directory, "missing.jsonl"))).toEqual(
      [],
    );
  });

  it("rejects malformed receipts on read", async () => {
    const path = join(directory, "bad.jsonl");
    await writeReceiptBundle(path, [receipt("verified", "r1")]);
    // Manually append a malformed line.
    await appendFile(path, '{"schemaVersion":"lhic-action-receipt-v9"}\n');
    expect(await readReceiptBundle(path)).toHaveLength(1);
  });
});
