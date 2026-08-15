import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { LhicResearchKernel, type KernelAdapters } from "../src/kernel.ts";
import { FileSideEffectLedger } from "../src/ledger.ts";
import type { ExecutionResult, ObservationOutcome, ResearchAction, VerificationEvidence } from "../src/model.ts";
import { exactApproval, passedEvidence, failedEvidence, deterministicHash } from "../experiments/real/common.ts";

function action(label: string): ResearchAction {
  return {
    actionId: `matrix:${label}`,
    taskId: `task:${label}`,
    surface: "code",
    tool: "git",
    intent: "modify a controlled workspace fixture",
    target: `fixture-${label}`,
    origin: "file://controlled-workspace",
    actionHash: deterministicHash(`matrix:${label}`),
  };
}

async function withKernel(
  label: string,
  adapters: KernelAdapters,
  fn: (kernel: LhicResearchKernel, ledger: FileSideEffectLedger, action: ResearchAction) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lhic-recovery-matrix-"));
  try {
    const ledger = new FileSideEffectLedger(join(dir, "ledger.json"));
    await ledger.load();
    const a = action(label);
    const kernel = new LhicResearchKernel(ledger, adapters);
    await fn(kernel, ledger, a);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function evidence(label: string, passed = true): VerificationEvidence {
  return passed
    ? passedEvidence(`evidence:${label}`, "controlled postcondition", label)
    : failedEvidence(`evidence:${label}`, "controlled postcondition", label);
}

test("pre-dispatch ambiguity with absent effect does not auto-dispatch", async () => {
  let dispatches = 0;
  const adapters: KernelAdapters = {
    async execute(): Promise<ExecutionResult> {
      dispatches += 1;
      return { accepted: true, sideEffectOccurred: false, responseReceived: false };
    },
    async observe(): Promise<ObservationOutcome> {
      return "effect_absent";
    },
    async verify(): Promise<VerificationEvidence> {
      return evidence("pre-dispatch", false);
    },
  };

  await withKernel("pre-dispatch", adapters, async (kernel, ledger, a) => {
    const first = await kernel.run(a, exactApproval(a));
    assert.equal(first.ledgerState, "possibly_committed");
    const recovered = await kernel.run(a, exactApproval(a));
    assert.equal(recovered.ledgerState, "needs_resolution");
    assert.match(recovered.failureReason ?? "", /safe to retry|did not occur/i);
    const repeated = await kernel.run(a, exactApproval(a));
    assert.equal(repeated.ledgerState, "needs_resolution");
    assert.equal(dispatches, 1, "ambiguous absent-effect recovery must not silently replay");
    assert.equal(ledger.canDispatch(a.actionId), false);
  });
});

test("delayed visibility can verify later without duplicate dispatch", async () => {
  let dispatches = 0;
  let observations = 0;
  let effectVisible = false;
  const adapters: KernelAdapters = {
    async execute(): Promise<ExecutionResult> {
      dispatches += 1;
      return { accepted: true, sideEffectOccurred: true, responseReceived: false };
    },
    async observe(): Promise<ObservationOutcome> {
      observations += 1;
      return effectVisible ? "effect_present" : "inconclusive";
    },
    async verify(): Promise<VerificationEvidence> {
      return evidence("delayed", effectVisible);
    },
  };

  await withKernel("delayed", adapters, async (kernel, _ledger, a) => {
    const first = await kernel.run(a, exactApproval(a));
    assert.equal(first.ledgerState, "possibly_committed");
    const notYetVisible = await kernel.run(a, exactApproval(a));
    assert.equal(notYetVisible.ledgerState, "needs_resolution");
    effectVisible = true;
    const later = await kernel.run(a, exactApproval(a));
    assert.equal(later.ledgerState, "verified");
    assert.equal(dispatches, 1);
    assert.equal(observations, 2);
  });
});

test("repeated inconclusive observations remain needs_resolution and non-dispatchable", async () => {
  let dispatches = 0;
  let observations = 0;
  const adapters: KernelAdapters = {
    async execute(): Promise<ExecutionResult> {
      dispatches += 1;
      return { accepted: true, sideEffectOccurred: true, responseReceived: false };
    },
    async observe(): Promise<ObservationOutcome> {
      observations += 1;
      return "inconclusive";
    },
    async verify(): Promise<VerificationEvidence> {
      return evidence("inconclusive", false);
    },
  };

  await withKernel("inconclusive", adapters, async (kernel, ledger, a) => {
    assert.equal((await kernel.run(a, exactApproval(a))).ledgerState, "possibly_committed");
    assert.equal((await kernel.run(a, exactApproval(a))).ledgerState, "needs_resolution");
    assert.equal((await kernel.run(a, exactApproval(a))).ledgerState, "needs_resolution");
    assert.equal(dispatches, 1);
    assert.equal(observations, 2);
    assert.equal(ledger.canDispatch(a.actionId), false);
  });
});

test("duplicate action delivery after verification is blocked", async () => {
  let dispatches = 0;
  const adapters: KernelAdapters = {
    async execute(): Promise<ExecutionResult> {
      dispatches += 1;
      return { accepted: true, sideEffectOccurred: true, responseReceived: true };
    },
    async observe(): Promise<ObservationOutcome> {
      return "effect_present";
    },
    async verify(): Promise<VerificationEvidence> {
      return evidence("duplicate-delivery", true);
    },
  };

  await withKernel("duplicate-delivery", adapters, async (kernel, _ledger, a) => {
    assert.equal((await kernel.run(a, exactApproval(a))).ledgerState, "verified");
    const duplicate = await kernel.run(a, exactApproval(a));
    assert.equal(duplicate.ledgerState, "verified");
    assert.match(duplicate.failureReason ?? "", /Replay blocked/i);
    assert.equal(dispatches, 1);
  });
});

test("workspace conflict during recovery prevents verified completion without replay", async () => {
  let dispatches = 0;
  let conflict = false;
  const adapters: KernelAdapters = {
    async execute(): Promise<ExecutionResult> {
      dispatches += 1;
      conflict = true;
      return { accepted: true, sideEffectOccurred: true, responseReceived: false };
    },
    async observe(): Promise<ObservationOutcome> {
      return "effect_present";
    },
    async verify(): Promise<VerificationEvidence> {
      return evidence("workspace-conflict", !conflict);
    },
  };

  await withKernel("workspace-conflict", adapters, async (kernel, _ledger, a) => {
    assert.equal((await kernel.run(a, exactApproval(a))).ledgerState, "possibly_committed");
    const recovered = await kernel.run(a, exactApproval(a));
    assert.equal(recovered.ledgerState, "executed");
    assert.match(recovered.failureReason ?? "", /retry would risk duplication/i);
    assert.equal(dispatches, 1);
  });
});
