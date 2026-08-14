import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readReceipts } from "@lhic/trace";

import { OmpActionReceiptObserver } from "./action-receipt-observer.js";

describe("OmpActionReceiptObserver", () => {
  let directory: string;
  let logPath: string;
  let observer: OmpActionReceiptObserver;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-omp-receipts-"));
    logPath = join(directory, "receipts.jsonl");
    observer = new OmpActionReceiptObserver({
      taskId: "task-1",
      sessionId: "session-1",
      modelId: "openai-codex/gpt-5.6-sol",
      receiptLogPath: logPath,
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("maps an OMP tool execution to a code receipt without LHIC verification", async () => {
    observer.feed({
      type: "tool_execution_start",
      id: "tool-1",
      toolName: "edit",
      args: { filePath: "src/main.ts" },
      taskId: "task-1",
    });
    observer.feed({
      type: "tool_execution_end",
      id: "tool-1",
      toolName: "edit",
      success: true,
      taskId: "task-1",
    });
    await observer.flush();
    const receipts = await readReceipts(logPath);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.surface).toBe("code");
    expect(receipt.tool).toBe("edit");
    expect(receipt.executor.authority).toBe("omp");
    expect(receipt.verification.authority).toBe("none");
    expect(receipt.verification.status).toBe("not_run");
    expect(receipt.planner.authority).toBe("omp");
    expect(receipt.planner.modelId).toBe("openai-codex/gpt-5.6-sol");
    expect(receipt.state).toBe("executed");
    // OMP success is execution evidence, never LHIC verification.
    expect(receipt.verification.authority).not.toBe("lhic");
    expect(receipt.verification.evidenceRefs).toEqual([]);
  });

  it("maps a failed tool to a failed receipt", async () => {
    observer.feed({
      type: "tool_execution_start",
      id: "tool-2",
      toolName: "bash",
      args: { command: "npm test" },
    });
    observer.feed({
      type: "tool_execution_end",
      id: "tool-2",
      toolName: "bash",
      status: "error",
    });
    await observer.flush();
    const receipts = await readReceipts(logPath);
    expect(receipts[0]?.state).toBe("failed");
    expect(receipts[0]?.sideEffectClass).toBe("local_execute");
    expect(receipts[0]?.surface).toBe("shell");
  });

  it("does not duplicate terminal receipts across restarts", async () => {
    observer.feed({
      type: "tool_execution_start",
      id: "tool-3",
      toolName: "write",
    });
    observer.feed({
      type: "tool_execution_end",
      id: "tool-3",
      toolName: "write",
      success: true,
    });
    await observer.flush();
    // A new observer over the same log (restart) sees the same tool end.
    const restarted = new OmpActionReceiptObserver({
      taskId: "task-1",
      receiptLogPath: logPath,
    });
    restarted.feed({
      type: "tool_execution_start",
      id: "tool-3",
      toolName: "write",
    });
    restarted.feed({
      type: "tool_execution_end",
      id: "tool-3",
      toolName: "write",
      success: true,
    });
    await restarted.flush();
    const receipts = await readReceipts(logPath);
    expect(receipts).toHaveLength(1);
  });

  it("ignores unrelated frames", async () => {
    observer.feed({ type: "message_update", messageId: "m1" });
    observer.feed({ type: "agent_start" });
    expect(await readReceipts(logPath)).toHaveLength(0);
  });
});
