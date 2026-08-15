import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LhicResearchKernel, type KernelAdapters } from "../../src/kernel.ts";
import { FileSideEffectLedger } from "../../src/ledger.ts";
import type { ExecutionResult, ObservationOutcome, ResearchAction, VerificationEvidence } from "../../src/model.ts";
import { deterministicHash, exactApproval, failedEvidence, passedEvidence } from "./common.ts";

interface MatrixCaseResult {
  caseName: string;
  expectedState: string;
  observedState: string;
  durableLedgerState: string | undefined;
  dispatches: number;
  observations: number;
  verifications: number;
  sideEffects: number;
  duplicateSideEffects: number;
  latencyMs: number;
  passed: boolean;
}

interface MatrixSummary {
  schemaVersion: "lhic-failure-matrix-v1";
  generatedAt: string;
  cases: MatrixCaseResult[];
  passed: number;
  failed: number;
  totalLatencyMs: number;
}

function makeAction(caseName: string): ResearchAction {
  return {
    actionId: `failure-matrix:${caseName}`,
    taskId: `failure-matrix-task:${caseName}`,
    surface: "code",
    tool: "filesystem",
    intent: `exercise ${caseName}`,
    target: `workspace/${caseName}.txt`,
    origin: "file://failure-matrix",
    actionHash: deterministicHash(`failure-matrix:${caseName}`),
  };
}

async function countMarkers(file: string): Promise<number> {
  try {
    const content = await readFile(file, "utf8");
    return content.split("\n").filter((line) => line.startsWith("LHIC_EFFECT")).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function appendEffect(file: string, label: string): Promise<void> {
  const previous = await countMarkers(file);
  const prefix = Array.from({ length: previous }, (_, i) => `LHIC_EFFECT ${i + 1}`).join("\n");
  await writeFile(file, `${prefix}${previous ? "\n" : ""}LHIC_EFFECT ${label}\n`, "utf8");
}

async function runCase(
  caseName: string,
  expectedState: string,
  makeAdapters: (ctx: {
    file: string;
    counters: { dispatches: number; observations: number; verifications: number };
  }) => KernelAdapters,
  recoveryAttempts = 1,
): Promise<MatrixCaseResult> {
  const dir = await mkdtemp(join(tmpdir(), "lhic-failure-matrix-"));
  const file = join(dir, "state.txt");
  const action = makeAction(caseName);
  const approval = exactApproval(action);
  const ledgerFile = join(dir, "ledger.json");
  const counters = { dispatches: 0, observations: 0, verifications: 0 };
  const start = Date.now();

  try {
    const adapters = makeAdapters({ file, counters });
    const ledger1 = new FileSideEffectLedger(ledgerFile);
    await ledger1.load();
    const kernel1 = new LhicResearchKernel(ledger1, adapters);
    let receipt = await kernel1.run(action, approval);

    for (let attempt = 0; attempt < recoveryAttempts; attempt += 1) {
      const ledgerN = new FileSideEffectLedger(ledgerFile);
      await ledgerN.load();
      const kernelN = new LhicResearchKernel(ledgerN, adapters);
      receipt = await kernelN.run(action, approval);
    }

    const finalLedger = new FileSideEffectLedger(ledgerFile);
    await finalLedger.load();
    const effects = await countMarkers(file);
    const durableLedgerState = finalLedger.get(action.actionId)?.state;
    const result: MatrixCaseResult = {
      caseName,
      expectedState,
      observedState: receipt.ledgerState,
      durableLedgerState,
      dispatches: counters.dispatches,
      observations: counters.observations,
      verifications: counters.verifications,
      sideEffects: effects,
      duplicateSideEffects: Math.max(0, effects - 1),
      latencyMs: Date.now() - start,
      passed:
        receipt.ledgerState === expectedState &&
        counters.dispatches === 1 &&
        Math.max(0, effects - 1) === 0,
    };
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function evidence(id: string, fileContent: string, ok: boolean): VerificationEvidence {
  return ok
    ? passedEvidence(`matrix:${id}`, "failure-matrix postcondition", fileContent)
    : failedEvidence(`matrix:${id}`, "failure-matrix postcondition", fileContent);
}

const cases = [
  runCase("pre-dispatch-crash", "needs_resolution", ({ file, counters }) => ({
    async execute(): Promise<ExecutionResult> {
      counters.dispatches += 1;
      return { accepted: true, sideEffectOccurred: false, responseReceived: false };
    },
    async observe(): Promise<ObservationOutcome> {
      counters.observations += 1;
      return (await countMarkers(file)) === 0 ? "effect_absent" : "effect_present";
    },
    async verify(): Promise<VerificationEvidence> {
      counters.verifications += 1;
      return evidence("pre-dispatch-crash", "", false);
    },
  })),
  runCase("delayed-visibility", "verified", ({ file, counters }) => {
    let firstObservation = true;
    return {
      async execute(): Promise<ExecutionResult> {
        counters.dispatches += 1;
        await appendEffect(file, "delayed-visibility");
        return { accepted: true, sideEffectOccurred: true, responseReceived: false };
      },
      async observe(): Promise<ObservationOutcome> {
        counters.observations += 1;
        if (firstObservation) {
          firstObservation = false;
          return "inconclusive";
        }
        return (await countMarkers(file)) === 1 ? "effect_present" : "effect_absent";
      },
      async verify(): Promise<VerificationEvidence> {
        counters.verifications += 1;
        const content = await readFile(file, "utf8");
        return evidence("delayed-visibility", content, (await countMarkers(file)) === 1);
      },
    };
  }, 2),
  runCase("inconclusive-observation", "needs_resolution", ({ file, counters }) => ({
    async execute(): Promise<ExecutionResult> {
      counters.dispatches += 1;
      await appendEffect(file, "inconclusive-observation");
      return { accepted: true, sideEffectOccurred: true, responseReceived: false };
    },
    async observe(): Promise<ObservationOutcome> {
      counters.observations += 1;
      return "inconclusive";
    },
    async verify(): Promise<VerificationEvidence> {
      counters.verifications += 1;
      return evidence("inconclusive-observation", "", false);
    },
  })),
  runCase("duplicate-delivery", "executed", ({ file, counters }) => ({
    async execute(): Promise<ExecutionResult> {
      counters.dispatches += 1;
      await appendEffect(file, "duplicate-delivery");
      return { accepted: true, sideEffectOccurred: true, responseReceived: true };
    },
    async observe(): Promise<ObservationOutcome> {
      counters.observations += 1;
      return "effect_present";
    },
    async verify(): Promise<VerificationEvidence> {
      counters.verifications += 1;
      const content = await readFile(file, "utf8");
      return evidence("duplicate-delivery", content, (await countMarkers(file)) === 1);
    },
  })),
  runCase("workspace-conflict", "executed", ({ file, counters }) => ({
    async execute(): Promise<ExecutionResult> {
      counters.dispatches += 1;
      await appendEffect(file, "workspace-conflict");
      await writeFile(file, `${await readFile(file, "utf8")}HUMAN_CONFLICT\n`, "utf8");
      return { accepted: true, sideEffectOccurred: true, responseReceived: false };
    },
    async observe(): Promise<ObservationOutcome> {
      counters.observations += 1;
      return (await countMarkers(file)) >= 1 ? "effect_present" : "effect_absent";
    },
    async verify(): Promise<VerificationEvidence> {
      counters.verifications += 1;
      const content = await readFile(file, "utf8");
      return evidence("workspace-conflict", content, !content.includes("HUMAN_CONFLICT"));
    },
  })),
];

const results = await Promise.all(cases);
const summary: MatrixSummary = {
  schemaVersion: "lhic-failure-matrix-v1",
  generatedAt: new Date().toISOString(),
  cases: results,
  passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length,
  totalLatencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
};

await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/failure-matrix-results.json", JSON.stringify(summary, null, 2), "utf8");
console.log(`LHIC_FAILURE_MATRIX=${JSON.stringify(summary)}`);

if (summary.failed > 0) {
  console.error(JSON.stringify(summary, null, 2));
  process.exitCode = 1;
}
