import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

import { LhicResearchKernel } from "../../src/kernel.ts";
import { FileSideEffectLedger } from "../../src/ledger.ts";
import type { ApprovalRecord, ExecutionResult, ResearchAction, VerificationEvidence } from "../../src/model.ts";

type Proposal = { ordinal: number; logicalActionId: string; command: string; commandSha256: string };
type Plan = {
  condition: string; trial: number; statePath: string; effectMode: string;
  downstreamIdempotency: string; proposals: Proposal[];
};
type EffectEvent = { logicalActionId?: string; committed?: boolean };
type EffectState = { attempts?: number; committedCount?: number; events?: EffectEvent[] };

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  return {
    fixtures: get("--fixtures")!,
    out: get("--out")!,
    repoRoot: get("--repo-root", process.cwd())!,
  };
}

function sha256(data: string | Buffer) {
  return createHash("sha256").update(data).digest("hex");
}

async function readState(path: string): Promise<EffectState> {
  try { return JSON.parse(await readFile(path, "utf8")) as EffectState; }
  catch { return { attempts: 0, committedCount: 0, events: [] }; }
}

function committedFor(state: EffectState, actionId: string) {
  return (state.events ?? []).filter((e) => e.committed && e.logicalActionId === actionId).length;
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

function actionFrom(plan: Plan, p: Proposal): ResearchAction {
  return {
    actionId: p.logicalActionId,
    taskId: `fair-harness:${plan.condition}:${String(plan.trial).padStart(2, "0")}`,
    surface: "shell",
    tool: "shell",
    intent: "execute the exact fair-comparator logical action",
    target: plan.statePath,
    actionHash: p.commandSha256,
  };
}

async function runTrial(fixtures: string, entry: any, outRoot: string, repoRoot: string, manifestSha: string) {
  const planPath = join(fixtures, entry.path);
  const planRaw = await readFile(planPath);
  const planSha = sha256(planRaw);
  if (planSha !== entry.sha256) throw new Error(`fixture hash mismatch: ${entry.path}`);
  const plan = JSON.parse(planRaw.toString("utf8")) as Plan;
  const trialDir = join(outRoot, plan.condition, `trial-${String(plan.trial).padStart(2, "0")}`);
  await mkdir(trialDir, { recursive: true });
  await copyFile(planPath, join(trialDir, "plan.json"));
  const statePrefix = "/tmp/lhic-fair-harness/";
  if (!resolve(plan.statePath).startsWith(statePrefix)) throw new Error(`unsafe state path ${plan.statePath}`);
  const stateDir = resolve(plan.statePath, "..");
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });

  const ledger = new FileSideEffectLedger(join(trialDir, "ledger.json"));
  await ledger.load();
  const commandByAction = new Map<string, string>();
  for (const p of plan.proposals) commandByAction.set(p.logicalActionId, p.command);
  const exitByAction = new Map<string, number | null>();
  let dispatches = 0;
  let observations = 0;
  let verifications = 0;

  const kernel = new LhicResearchKernel(ledger, {
    async execute(action: ResearchAction): Promise<ExecutionResult> {
      const command = commandByAction.get(action.actionId);
      if (!command) throw new Error(`missing command for ${action.actionId}`);
      dispatches += 1;
      const cp = spawnSync(command, { shell: true, cwd: repoRoot, encoding: "utf8" });
      const status = cp.status ?? (cp.signal ? 128 : 1);
      exitByAction.set(action.actionId, status);
      const state = await readState(plan.statePath);
      return {
        accepted: status === 0,
        sideEffectOccurred: committedFor(state, action.actionId) > 0,
        responseReceived: true,
        detail: `exit=${status};stdout=${cp.stdout};stderr=${cp.stderr}`,
      };
    },
    async observe(action: ResearchAction) {
      observations += 1;
      const state = await readState(plan.statePath);
      return committedFor(state, action.actionId) > 0 ? "effect_present" as const : "effect_absent" as const;
    },
    async verify(action: ResearchAction): Promise<VerificationEvidence> {
      verifications += 1;
      const raw = await readFile(plan.statePath, "utf8");
      const state = JSON.parse(raw) as EffectState;
      const n = committedFor(state, action.actionId);
      return {
        evidenceId: `evidence:${action.actionId}:${verifications}`,
        verifier: "lhic",
        condition: "the current logical action ID has exactly one committed effect",
        result: n === 1 ? "passed" : "failed",
        artifactHashes: [sha256(raw)],
        createdAt: new Date().toISOString(),
      };
    },
  });

  const receipts: any[] = [];
  const firstAction = actionFrom(plan, plan.proposals[0]);
  receipts.push(await kernel.run(firstAction, exactApproval(firstAction)));
  const firstExit = exitByAction.get(firstAction.actionId);
  let plannerPolicyValid = plan.effectMode === "success" ? firstExit === 0 : firstExit === 17;
  if (plan.proposals.length > 1 && plannerPolicyValid) {
    const secondAction = actionFrom(plan, plan.proposals[1]);
    receipts.push(await kernel.run(secondAction, exactApproval(secondAction)));
  }

  const state = await readState(plan.statePath);
  const attempts = Number(state.attempts ?? 0);
  const committed = Number(state.committedCount ?? 0);
  const ids = plan.proposals.map((p) => p.logicalActionId);
  const sameId = ids.length === 2 && ids[0] === ids[1];
  const committedById = new Map<string, number>();
  for (const e of state.events ?? []) {
    if (e.committed && e.logicalActionId) committedById.set(e.logicalActionId, (committedById.get(e.logicalActionId) ?? 0) + 1);
  }
  const duplicateCommittedEffects = [...committedById.values()].reduce((n, v) => n + Math.max(0, v - 1), 0);
  const result = {
    harness: "lhic-core",
    condition: plan.condition,
    trial: plan.trial,
    planSha256: planSha,
    fixtureManifestSha256: manifestSha,
    logicalActionIds: ids,
    commandSha256s: plan.proposals.map((p) => p.commandSha256),
    sameLogicalActionPlan: sameId,
    plannerPolicyValid,
    plannerProposalsIssued: receipts.length,
    physicalDispatchAttempts: attempts,
    adapterDispatchCount: dispatches,
    committedEffects: committed,
    secondPhysicalDispatch: attempts >= 2,
    sameLogicalActionSecondDispatch: sameId && attempts >= 2,
    duplicateCommittedEffects,
    downstreamSuppressedDispatches: Math.max(0, attempts - committed),
    observations,
    verifications,
    receiptLedgerStates: receipts.map((r) => r.ledgerState),
    toolName: "lhic-core-shell-adapter",
    valid: plannerPolicyValid && attempts >= 1 && attempts === dispatches,
  };
  await writeFile(join(trialDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
  try { await copyFile(plan.statePath, join(trialDir, "state.json")); } catch {}
  console.log(JSON.stringify(result));
  return result;
}

function summarize(results: any[], condition: string) {
  const rs = results.filter((r) => r.condition === condition);
  return {
    trials: rs.length,
    validTrials: rs.filter((r) => r.valid).length,
    secondPhysicalDispatchTrials: rs.filter((r) => r.secondPhysicalDispatch).length,
    sameLogicalActionSecondDispatchTrials: rs.filter((r) => r.sameLogicalActionSecondDispatch).length,
    duplicateCommittedEffects: rs.reduce((n, r) => n + r.duplicateCommittedEffects, 0),
    downstreamSuppressedDispatches: rs.reduce((n, r) => n + r.downstreamSuppressedDispatches, 0),
    meanPhysicalDispatchAttempts: rs.reduce((n, r) => n + r.physicalDispatchAttempts, 0) / rs.length,
    meanCommittedEffects: rs.reduce((n, r) => n + r.committedEffects, 0) / rs.length,
    toolNames: ["lhic-core-shell-adapter"],
  };
}

async function main() {
  const args = parseArgs();
  const manifest = JSON.parse(await readFile(join(args.fixtures, "manifest.json"), "utf8"));
  await rm(args.out, { recursive: true, force: true });
  await mkdir(args.out, { recursive: true });
  const results: any[] = [];
  for (const entry of manifest.entries) {
    results.push(await runTrial(args.fixtures, entry, args.out, args.repoRoot, manifest.manifestSha256));
  }
  const conditions: Record<string, any> = {};
  for (const c of manifest.conditions) conditions[c] = summarize(results, c);
  const summary = {
    schemaVersion: "lhic-fair-public-harness-summary-v1",
    harness: "lhic-core",
    runtime: { node: process.version, platform: process.platform, arch: process.arch, gitSha: process.env.GITHUB_SHA ?? null },
    fixtureManifestSha256: manifest.manifestSha256,
    conditions,
    results,
  };
  await writeFile(join(args.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  if (results.some((r) => !r.valid)) process.exitCode = 2;
}

await main();
