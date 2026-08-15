import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LhicResearchKernel } from "../src/kernel.ts";
import { FileSideEffectLedger } from "../src/ledger.ts";
import type {
  ApprovalRecord,
  ExecutionResult,
  ResearchAction,
  VerificationEvidence,
} from "../src/model.ts";

const action: ResearchAction = {
  actionId: "purchase-1",
  taskId: "task-1",
  surface: "browser",
  tool: "click",
  intent: "purchase item at checkout",
  target: "Place order",
  origin: "https://example.test",
  actionHash: "d".repeat(64),
};

function exactApproval(): ApprovalRecord {
  return {
    approvalId: "approval-1",
    approvedBy: "operator",
    authority: "operator",
    createdAt: new Date().toISOString(),
    scope: {
      type: "exact_action",
      actionHash: action.actionHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function passingEvidence(): VerificationEvidence {
  return {
    evidenceId: "evidence-1",
    verifier: "lhic",
    condition: "purchase postcondition exists exactly once",
    result: "passed",
    artifactHashes: ["e".repeat(64)],
    createdAt: new Date().toISOString(),
  };
}

test("lost response after external effect is recovered without a second dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lhic-kernel-recovery-"));
  try {
    const ledger = new FileSideEffectLedger(join(dir, "ledger.json"));
    await ledger.load();

    let dispatches = 0;
    let observations = 0;
    let verifications = 0;

    const kernel = new LhicResearchKernel(ledger, {
      async execute(): Promise<ExecutionResult> {
        dispatches += 1;
        return {
          accepted: true,
          sideEffectOccurred: true,
          responseReceived: false,
          detail: "effect committed but response was lost",
        };
      },
      async observe() {
        observations += 1;
        return "effect_present" as const;
      },
      async verify() {
        verifications += 1;
        return passingEvidence();
      },
    });

    const first = await kernel.run(action, exactApproval());
    assert.equal(first.ledgerState, "possibly_committed");
    assert.equal(dispatches, 1);
    assert.equal(observations, 0);

    const recovered = await kernel.run(action, exactApproval());
    assert.equal(recovered.ledgerState, "verified");
    assert.equal(dispatches, 1, "recovery must not dispatch the purchase again");
    assert.equal(observations, 1);
    assert.equal(verifications, 1);
    assert.equal(ledger.get(action.actionId)?.state, "verified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verified action identity remains terminal across subsequent runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lhic-kernel-terminal-"));
  try {
    const ledger = new FileSideEffectLedger(join(dir, "ledger.json"));
    await ledger.load();

    let dispatches = 0;
    const kernel = new LhicResearchKernel(ledger, {
      async execute(): Promise<ExecutionResult> {
        dispatches += 1;
        return { accepted: true, sideEffectOccurred: true, responseReceived: false };
      },
      async observe() {
        return "effect_present" as const;
      },
      async verify() {
        return passingEvidence();
      },
    });

    await kernel.run(action, exactApproval());
    await kernel.run(action, exactApproval());
    const replay = await kernel.run(action, exactApproval());

    assert.match(replay.failureReason ?? "", /replay blocked/i);
    assert.equal(ledger.get(action.actionId)?.state, "verified");
    assert.equal(dispatches, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
