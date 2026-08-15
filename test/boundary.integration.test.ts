import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SplitExecutionBoundary } from "../src/boundary.ts";
import { FileSideEffectLedger } from "../src/ledger.ts";
import type { ApprovalRecord, ResearchAction, VerificationEvidence } from "../src/model.ts";

function action(id: string): ResearchAction {
  return {
    actionId: id,
    taskId: `task:${id}`,
    surface: "desktop",
    tool: "pyautogui",
    intent: "execute benchmark desktop action",
    target: "pyautogui.click(10, 20)",
    actionHash: "a".repeat(64),
  };
}

function approval(input: ResearchAction): ApprovalRecord {
  return {
    approvalId: `approval:${input.actionId}`,
    approvedBy: "benchmark-operator",
    authority: "operator",
    createdAt: new Date().toISOString(),
    scope: {
      type: "exact_action",
      actionHash: input.actionHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

async function withBoundary(
  fn: (boundary: SplitExecutionBoundary, ledgerFile: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lhic-boundary-test-"));
  try {
    const ledgerFile = join(dir, "ledger.json");
    const ledger = new FileSideEffectLedger(ledgerFile);
    await ledger.load();
    await fn(new SplitExecutionBoundary(ledger), ledgerFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("split boundary persists possibly_committed before permitting external dispatch", async () => {
  await withBoundary(async (boundary, ledgerFile) => {
    const input = action("boundary-prepare");
    const prepared = await boundary.prepare(input, approval(input));
    assert.equal(prepared.dispatchAllowed, true);
    assert.equal(prepared.state, "possibly_committed");

    const restartedLedger = new FileSideEffectLedger(ledgerFile);
    await restartedLedger.load();
    assert.equal(restartedLedger.get(input.actionId)?.state, "possibly_committed");
    assert.equal(restartedLedger.canDispatch(input.actionId), false);
  });
});

test("executor response records executed but never self-certifies verification", async () => {
  await withBoundary(async (boundary) => {
    const input = action("boundary-response");
    await boundary.prepare(input, approval(input));
    const response = await boundary.recordResponse(input.actionId);
    assert.equal(response.state, "executed");
    assert.equal(response.dispatchAllowed, false);
    assert.equal(boundary.state(input.actionId)?.state, "executed");
  });
});

test("lost response remains ambiguous and recovery can verify without redispatch", async () => {
  await withBoundary(async (boundary) => {
    const input = action("boundary-recover");
    await boundary.prepare(input, approval(input));
    const lost = boundary.recordLostResponse(input.actionId);
    assert.equal(lost.state, "possibly_committed");

    const evidence: VerificationEvidence = {
      evidenceId: "boundary-evidence",
      verifier: "lhic",
      condition: "external postcondition",
      result: "passed",
      artifactHashes: ["b".repeat(64)],
      createdAt: new Date().toISOString(),
    };
    const recovered = await boundary.recover(input.actionId, "effect_present", evidence);
    assert.equal(recovered.state, "verified");
    assert.equal(recovered.dispatchAllowed, false);

    const replay = await boundary.prepare(input, approval(input));
    assert.equal(replay.dispatchAllowed, false);
    assert.equal(replay.state, "verified");
  });
});
