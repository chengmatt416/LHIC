import { describe, expect, it } from "vitest";

import type { AgentActionReceipt } from "@lhic/schema";

import {
  provenanceJson,
  provenanceLines,
  renderProvenance,
} from "./provenance.js";

const receipt: AgentActionReceipt = {
  schemaVersion: "lhic-action-receipt-v1",
  receiptId: "r1",
  actionId: "step-1",
  taskId: "task-1",
  surface: "browser",
  tool: "lhic_browser_execute",
  intent: 'click "Submit"',
  sideEffectClass: "external_write",
  inferredRisk: "medium",
  approval: {
    required: true,
    status: "approved",
    authority: "lhic",
    actionHash: "a".repeat(64),
    approvedBy: "matt",
  },
  planner: { authority: "omp", modelId: "openai-codex/gpt-5.6-sol" },
  executor: { authority: "lhic", backend: "playwright" },
  verification: {
    authority: "lhic",
    status: "passed",
    evidenceRefs: ["evidence:abc"],
  },
  state: "verified",
  startedAt: "2026-08-14T00:00:00.000Z",
  completedAt: "2026-08-14T00:00:01.000Z",
};

describe("provenance rendering", () => {
  it("renders per-action provenance lines with explicit authority", () => {
    const lines = provenanceLines(receipt);
    const byField = Object.fromEntries(
      lines.map((line) => [line.field, line.value]),
    );
    expect(byField["Planner"]).toContain("omp");
    expect(byField["Planner"]).toContain("openai-codex/gpt-5.6-sol");
    expect(byField["Surface"]).toBe("browser");
    expect(byField["Side-effect class"]).toBe("external_write");
    expect(byField["Approval"]).toContain("approved / lhic");
    expect(byField["Executor"]).toContain("lhic");
    expect(byField["Verifier"]).toContain("lhic / passed");
    expect(byField["Evidence"]).toContain("1 ref(s)");
  });

  it("renders an empty state and JSON output", () => {
    expect(renderProvenance([])).toBe("No action receipts found.");
    const json = JSON.parse(provenanceJson([receipt])) as Array<
      Record<string, unknown>
    >;
    expect(json[0]?.surface).toBe("browser");
    expect(json[0]?.verification).toEqual({
      authority: "lhic",
      status: "passed",
      evidenceRefs: ["evidence:abc"],
    });
  });
});
