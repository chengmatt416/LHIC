import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { approvalAllows } from "../src/approval.ts";
import { FileSideEffectLedger } from "../src/ledger.ts";
import { mayPromoteToTrustedSkill } from "../src/memory.ts";
import type {
  AgentActionReceipt,
  ApprovalRecord,
  MemoryRecord,
  ResearchAction,
  SideEffectLedgerEntry,
} from "../src/model.ts";
import { effectiveSideEffectClass } from "../src/policy.ts";
import { decideRecovery } from "../src/recovery.ts";
import { buildReceipt } from "../src/receipt.ts";

const action: ResearchAction = {
  actionId: "a1",
  taskId: "t1",
  surface: "browser",
  tool: "click",
  intent: "purchase item",
  target: "checkout",
  origin: "https://example.test",
  actionHash: "a".repeat(64),
};

test("planner cannot lower independently inferred risk", () => {
  assert.equal(effectiveSideEffectClass("read", "purchase"), "purchase");
});

test("high-risk action cannot use reusable origin scope", () => {
  const approval: ApprovalRecord = {
    approvalId: "p1",
    approvedBy: "operator",
    authority: "operator",
    createdAt: new Date().toISOString(),
    scope: {
      type: "origin_action_class",
      origin: "https://example.test",
      sideEffectClass: "purchase",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxActions: 5,
    },
  };
  const result = approvalAllows(approval, action, "purchase", {
    now: new Date(),
    resolvedOrigin: action.origin,
    usageCount: 0,
  });
  assert.equal(result.allowed, false);
});

test("verification requires independent non-empty evidence", () => {
  const receipt = buildReceipt({
    receiptId: "r1",
    action,
    sideEffectClass: "purchase",
    ledgerState: "verified",
    evidence: [],
  });
  assert.equal(receipt.ledgerState, "executed");
  assert.equal(receipt.verificationAuthority, "none");
});

test("ambiguous side effect is not blindly retried", () => {
  const entry: SideEffectLedgerEntry = {
    schemaVersion: "lhic-side-effect-ledger-v1",
    actionId: "a1",
    actionHash: action.actionHash,
    taskId: "t1",
    surface: "browser",
    sideEffectClass: "purchase",
    state: "possibly_committed",
    evidenceIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const decision = decideRecovery(entry, "inconclusive", false);
  assert.equal(decision.decision, "human_resolution");
});

test("verified action identity cannot be dispatched again", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lhic-core-test-"));
  try {
    const ledger = new FileSideEffectLedger(join(dir, "ledger.json"));
    await ledger.load();
    const now = new Date().toISOString();
    await ledger.put({
      schemaVersion: "lhic-side-effect-ledger-v1",
      actionId: "a1",
      actionHash: action.actionHash,
      taskId: "t1",
      surface: "browser",
      sideEffectClass: "purchase",
      state: "possibly_committed",
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await ledger.transition("a1", "verified", "e1");
    assert.equal(ledger.canDispatch("a1"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted skill promotion requires three independent verified task IDs", () => {
  const record: MemoryRecord = {
    schemaVersion: "lhic-memory-v1",
    id: "skill1",
    namespace: "verified_skill",
    trust: "verifier_backed",
    sourceTaskIds: ["t1", "t2", "t3"],
    sourceReceiptIds: ["r1", "r2", "r3"],
    holdoutPassed: true,
    contentHash: "b".repeat(64),
  };
  const receipts: AgentActionReceipt[] = ["t1", "t2", "t3"].map((taskId, i) => ({
    schemaVersion: "lhic-action-receipt-v1",
    receiptId: `r${i + 1}`,
    actionId: `a${i + 1}`,
    taskId,
    surface: "browser",
    tool: "click",
    sideEffectClass: "read",
    plannerAuthority: "planner",
    approvalAuthority: "none",
    executionAuthority: "lhic",
    verificationAuthority: "lhic",
    ledgerState: "verified",
    evidence: [
      {
        evidenceId: `e${i + 1}`,
        verifier: "lhic",
        condition: "postcondition",
        result: "passed",
        artifactHashes: ["c".repeat(64)],
        createdAt: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
  }));
  assert.equal(mayPromoteToTrustedSkill({ record, receipts }), true);
  assert.equal(
    mayPromoteToTrustedSkill({ record, receipts: [receipts[0]!, receipts[0]!, receipts[0]!] }),
    false,
  );
});
