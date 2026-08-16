import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { LhicResearchKernel } from "../../src/kernel.ts";
import { FileSideEffectLedger } from "../../src/ledger.ts";
import type {
  ApprovalRecord,
  ExecutionResult,
  ResearchAction,
  VerificationEvidence,
} from "../../src/model.ts";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  return {
    trials: Number(get("--trials", "10")),
    out: get("--out", "artifacts/public-harness-comparator/lhic")!,
    effectScript: get(
      "--effect-script",
      "experiments/public-harness-comparator/effect.py",
    )!,
  };
}

async function readStateCount(path: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { count?: number };
    return Number(parsed.count ?? 0);
  } catch {
    return 0;
  }
}

function exactApproval(action: ResearchAction): ApprovalRecord {
  return {
    approvalId: `approval:${action.actionId}`,
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

async function runTrial(
  condition: "no_fault" | "post_commit_error",
  trial: number,
  outRoot: string,
  effectScript: string,
) {
  const trialDir = join(outRoot, condition, `trial-${String(trial).padStart(2, "0")}`);
  await mkdir(trialDir, { recursive: true });
  const statePath = join(trialDir, "state.json");
  const ledgerPath = join(trialDir, "ledger.json");
  const actionHash = createHash("sha256")
    .update(`public-comparator:${condition}:${trial}`)
    .digest("hex");
  const action: ResearchAction = {
    actionId: `public-comparator:${condition}:${trial}`,
    taskId: `public-comparator-task:${condition}:${trial}`,
    surface: "shell",
    tool: "shell",
    intent: "commit exactly one durable comparator side effect",
    target: statePath,
    actionHash,
  };

  const ledger = new FileSideEffectLedger(ledgerPath);
  await ledger.load();
  let dispatches = 0;
  let observations = 0;
  let verifications = 0;

  const kernel = new LhicResearchKernel(ledger, {
    async execute(): Promise<ExecutionResult> {
      dispatches += 1;
      const mode = condition === "no_fault" ? "success" : "post_commit_error";
      const result = spawnSync(
        "python3",
        [resolve(effectScript), "--state", resolve(statePath), "--mode", mode],
        { encoding: "utf8" },
      );
      const count = await readStateCount(statePath);
      return {
        accepted: result.status === 0,
        sideEffectOccurred: count > 0,
        responseReceived: true,
        detail: `exit=${result.status};signal=${result.signal ?? "none"}`,
      };
    },
    async observe() {
      observations += 1;
      return (await readStateCount(statePath)) > 0
        ? ("effect_present" as const)
        : ("effect_absent" as const);
    },
    async verify(): Promise<VerificationEvidence> {
      verifications += 1;
      const raw = await readFile(statePath, "utf8");
      const count = await readStateCount(statePath);
      return {
        evidenceId: `evidence:${action.actionId}:${verifications}`,
        verifier: "lhic",
        condition: "exactly one durable comparator side effect exists",
        result: count === 1 ? "passed" : "failed",
        artifactHashes: [createHash("sha256").update(raw).digest("hex")],
        createdAt: new Date().toISOString(),
      };
    },
  });

  const approval = exactApproval(action);
  const first = await kernel.run(action, approval);
  // The deterministic retry-oriented planner proposes the same logical action again
  // after the first tool outcome. LHIC receives the same stable action identity.
  const second = await kernel.run(action, approval);
  const count = await readStateCount(statePath);
  const result = {
    harness: "lhic-core",
    condition,
    trial,
    firstLedgerState: first.ledgerState,
    secondLedgerState: second.ledgerState,
    physicalDispatches: dispatches,
    physicalSideEffects: count,
    duplicateSideEffects: Math.max(0, count - 1),
    secondPhysicalDispatch: dispatches >= 2,
    observations,
    verifications,
    valid: count >= 1 && dispatches >= 1,
  };
  await writeFile(join(trialDir, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  return result;
}

async function main() {
  const args = parseArgs();
  const root = resolve(args.out);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const results: Awaited<ReturnType<typeof runTrial>>[] = [];
  for (const condition of ["no_fault", "post_commit_error"] as const) {
    for (let i = 1; i <= args.trials; i += 1) {
      results.push(await runTrial(condition, i, root, args.effectScript));
    }
  }
  const summarize = (condition: "no_fault" | "post_commit_error") => {
    const rs = results.filter((r) => r.condition === condition);
    return {
      trials: rs.length,
      validTrials: rs.filter((r) => r.valid).length,
      secondDispatchTrials: rs.filter((r) => r.secondPhysicalDispatch).length,
      duplicateSideEffects: rs.reduce((n, r) => n + r.duplicateSideEffects, 0),
      meanPhysicalSideEffects:
        rs.reduce((n, r) => n + r.physicalSideEffects, 0) / rs.length,
      verifiedAfterSecondRequest: rs.filter((r) => r.secondLedgerState === "verified").length,
    };
  };
  const summary = {
    schemaVersion: "lhic-public-harness-comparator-v1",
    harness: "lhic-core",
    planner: "deterministic retry-oriented logical action request",
    conditions: {
      no_fault: summarize("no_fault"),
      post_commit_error: summarize("post_commit_error"),
    },
    results,
  };
  await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2));
  const invalid = results.filter((r) => !r.valid);
  if (invalid.length > 0) process.exitCode = 2;
}

await main();
