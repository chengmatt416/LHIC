import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { SplitExecutionBoundary } from "../src/boundary.ts";
import { LhicResearchKernel } from "../src/kernel.ts";
import { FileSideEffectLedger } from "../src/ledger.ts";
import type { ApprovalRecord, ResearchAction, VerificationEvidence } from "../src/model.ts";

interface Sample {
  variant: Variant;
  trial: number;
  elapsedMs: number;
}

type Variant =
  | "direct_execute"
  | "direct_execute_verify"
  | "split_boundary"
  | "full_kernel";

interface SummaryRow {
  variant: Variant;
  trials: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

const parsed = Number.parseInt(process.env.LHIC_OVERHEAD_TRIALS ?? "80", 10);
const trials = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 80;
const variants: Variant[] = [
  "direct_execute",
  "direct_execute_verify",
  "split_boundary",
  "full_kernel",
];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeAction(variant: Variant, trial: number): ResearchAction {
  const actionId = `overhead:${variant}:${trial}`;
  return {
    actionId,
    taskId: `overhead-task:${variant}:${trial}`,
    surface: "code",
    tool: "write_file",
    intent: "write no-fault overhead marker",
    target: "effect.txt",
    actionHash: hash(actionId),
  };
}

function approval(action: ResearchAction): ApprovalRecord {
  return {
    approvalId: `approval:${action.actionId}`,
    approvedBy: "overhead-harness",
    authority: "operator",
    createdAt: new Date().toISOString(),
    scope: {
      type: "exact_action",
      actionHash: action.actionHash,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
}

function evidence(action: ResearchAction, artifact: string): VerificationEvidence {
  return {
    evidenceId: `evidence:${action.actionId}`,
    verifier: "lhic",
    condition: "no-fault marker exists exactly as written",
    result: "passed",
    artifactHashes: [hash(artifact)],
    createdAt: new Date().toISOString(),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

function summarize(samples: Sample[], variant: Variant): SummaryRow {
  const values = samples
    .filter((sample) => sample.variant === variant)
    .map((sample) => sample.elapsedMs)
    .sort((a, b) => a - b);
  return {
    variant,
    trials: values.length,
    meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: values[0] ?? 0,
    maxMs: values.at(-1) ?? 0,
  };
}

async function runTrial(root: string, variant: Variant, trial: number): Promise<Sample> {
  const dir = join(root, `${variant}-${trial}`);
  await mkdir(dir, { recursive: true });
  const effectFile = join(dir, "effect.txt");
  const ledgerFile = join(dir, "ledger.json");
  const marker = `LHIC_OVERHEAD_${variant}_${trial}`;
  const action = makeAction(variant, trial);
  const exact = approval(action);

  const start = performance.now();

  if (variant === "direct_execute") {
    await writeFile(effectFile, `${marker}\n`, "utf8");
  } else if (variant === "direct_execute_verify") {
    await writeFile(effectFile, `${marker}\n`, "utf8");
    const observed = await readFile(effectFile, "utf8");
    if (observed !== `${marker}\n`) throw new Error("Direct verification failed.");
  } else if (variant === "split_boundary") {
    const ledger = new FileSideEffectLedger(ledgerFile);
    await ledger.load();
    const boundary = new SplitExecutionBoundary(ledger);
    const prepared = await boundary.prepare(action, exact);
    if (!prepared.dispatchAllowed || prepared.state !== "possibly_committed") {
      throw new Error(`Boundary failed to prepare: ${JSON.stringify(prepared)}`);
    }
    await writeFile(effectFile, `${marker}\n`, "utf8");
    const recorded = await boundary.recordResponse(action.actionId);
    if (recorded.state !== "executed") throw new Error("Boundary did not record executed state.");
  } else {
    const ledger = new FileSideEffectLedger(ledgerFile);
    await ledger.load();
    const kernel = new LhicResearchKernel(ledger, {
      async execute() {
        await writeFile(effectFile, `${marker}\n`, "utf8");
        return { accepted: true, sideEffectOccurred: true, responseReceived: true };
      },
      async observe() {
        try {
          return (await readFile(effectFile, "utf8")) === `${marker}\n`
            ? "effect_present" as const
            : "effect_absent" as const;
        } catch {
          return "effect_absent" as const;
        }
      },
      async verify() {
        const observed = await readFile(effectFile, "utf8");
        return evidence(action, observed);
      },
    });
    const receipt = await kernel.run(action, exact);
    if (receipt.ledgerState !== "verified") throw new Error("Full kernel did not reach verified.");
  }

  const elapsedMs = performance.now() - start;
  return { variant, trial, elapsedMs };
}

const root = await mkdtemp(join(tmpdir(), "lhic-overhead-"));
try {
  // One untimed warm-up for each variant reduces one-off module/filesystem effects.
  for (const variant of variants) await runTrial(root, variant, 0);

  const samples: Sample[] = [];
  // Interleave variants per trial to reduce systematic temporal bias.
  for (let trial = 1; trial <= trials; trial += 1) {
    for (const variant of variants) {
      samples.push(await runTrial(root, variant, trial));
    }
  }

  const summary = variants.map((variant) => summarize(samples, variant));
  const directMedian = summary.find((row) => row.variant === "direct_execute")!.medianMs;
  const directVerifyMedian = summary.find((row) => row.variant === "direct_execute_verify")!.medianMs;
  const splitMedian = summary.find((row) => row.variant === "split_boundary")!.medianMs;
  const fullMedian = summary.find((row) => row.variant === "full_kernel")!.medianMs;

  const output = {
    schemaVersion: "lhic-no-fault-overhead-v1",
    generatedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      trials,
      persistence: "academic atomic-JSON reference ledger",
    },
    summary,
    derived: {
      splitBoundaryMinusDirectMedianMs: splitMedian - directMedian,
      fullKernelMinusDirectVerifyMedianMs: fullMedian - directVerifyMedian,
      fullKernelOverDirectMedianRatio: directMedian > 0 ? fullMedian / directMedian : null,
    },
    caveat:
      "Microbenchmark of the academic JSON reference artifact. It is not production LHIC latency and does not include browser/desktop/network action cost.",
    samples,
  };

  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/no-fault-overhead-results.json",
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  );
  console.log(`LHIC_NO_FAULT_OVERHEAD=${JSON.stringify(output)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
