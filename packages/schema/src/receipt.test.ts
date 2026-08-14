import { describe, expect, it } from "vitest";

import {
  isAgentActionReceipt,
  isApprovalScope,
  isSideEffectClass,
} from "./receipt.js";

const baseReceipt = {
  schemaVersion: "lhic-action-receipt-v1",
  receiptId: "receipt-1",
  actionId: "step-1",
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
    evidenceRefs: ["evidence:abc"],
  },
  state: "verified",
  startedAt: "2026-08-14T00:00:00.000Z",
} as const;

describe("receipt schema", () => {
  it("accepts a complete valid receipt", () => {
    expect(isAgentActionReceipt(baseReceipt)).toBe(true);
  });

  it("rejects an unknown schema version", () => {
    expect(
      isAgentActionReceipt({
        ...baseReceipt,
        schemaVersion: "lhic-action-receipt-v2",
      }),
    ).toBe(false);
  });

  it("rejects receipts missing mandatory identity fields", () => {
    expect(isAgentActionReceipt({ ...baseReceipt, receiptId: "" })).toBe(false);
    expect(isAgentActionReceipt({ ...baseReceipt, taskId: undefined })).toBe(
      false,
    );
    expect(
      isAgentActionReceipt({ ...baseReceipt, surface: "filesystem" }),
    ).toBe(false);
    expect(
      isAgentActionReceipt({ ...baseReceipt, sideEffectClass: "benign" }),
    ).toBe(false);
  });

  it("rejects receipts with invalid authority or verification labels", () => {
    expect(
      isAgentActionReceipt({
        ...baseReceipt,
        executor: { authority: "lhic" },
        verification: { authority: "lhic", status: "passed", evidenceRefs: [] },
      }),
    ).toBe(true);
    expect(
      isAgentActionReceipt({
        ...baseReceipt,
        verification: {
          authority: "unknown",
          status: "passed",
          evidenceRefs: [],
        },
      }),
    ).toBe(false);
    expect(
      isAgentActionReceipt({
        ...baseReceipt,
        approval: {
          required: true,
          status: "approved",
          authority: "not-an-authority",
        },
      }),
    ).toBe(false);
  });

  it("rejects malformed fallback chains and scopes", () => {
    expect(
      isAgentActionReceipt({
        ...baseReceipt,
        executor: {
          authority: "lhic",
          fallbackChain: [
            {
              backend: "accessibility",
              target: "Submit",
              result: "no_match",
              timestamp: "2026-08-14T00:00:00.000Z",
            },
            {
              backend: "vision",
              target: "Submit",
              result: "matched",
              confidence: 0.9,
              timestamp: "2026-08-14T00:00:01.000Z",
            },
          ],
        },
      }),
    ).toBe(true);
    expect(
      isAgentActionReceipt({
        ...baseReceipt,
        executor: {
          authority: "lhic",
          fallbackChain: [
            {
              backend: "vision",
              target: "Submit",
              result: "fabricated",
              timestamp: "not-a-date",
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("accepts and rejects approval scopes strictly", () => {
    expect(
      isApprovalScope({ type: "exact_action", actionHash: "a".repeat(64) }),
    ).toBe(true);
    expect(
      isApprovalScope({
        type: "task_readonly",
        taskId: "t1",
        expiresAt: "2026-08-14T00:30:00.000Z",
      }),
    ).toBe(true);
    expect(isApprovalScope({ type: "exact_action", actionHash: "short" })).toBe(
      false,
    );
    expect(
      isApprovalScope({
        type: "origin_action_class",
        origin: "https://example.com",
        sideEffectClass: "read",
        expiresAt: "2026-08-14T00:30:00.000Z",
        maxActions: 0,
      }),
    ).toBe(false);
    expect(isApprovalScope({ type: "allow_all" })).toBe(false);
  });

  it("classifies side-effect classes strictly", () => {
    expect(isSideEffectClass("read")).toBe(true);
    expect(isSideEffectClass("financial_transfer")).toBe(true);
    expect(isSideEffectClass("benign")).toBe(false);
  });
});
