import { execFileSync, spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { LhicResearchKernel } from "../../src/kernel.ts";
import { FileSideEffectLedger } from "../../src/ledger.ts";
import type { ExecutionResult, ResearchAction, VerificationEvidence } from "../../src/model.ts";
import {
  deterministicHash,
  exactApproval,
  failedEvidence,
  passedEvidence,
  summarize,
  trialCount,
  type SurfaceTrialResult,
} from "./common.ts";

const thisFile = fileURLToPath(import.meta.url);
const nodeArgs = ["--experimental-strip-types", thisFile];

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

async function initRepo(repo: string): Promise<void> {
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "LHIC Academic Experiment"]);
  git(repo, ["config", "user.email", "lhic-experiment@example.invalid"]);
  await writeFile(join(repo, "README.md"), "# isolated code experiment\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
}

async function markerCount(repo: string, marker: string): Promise<number> {
  try {
    const text = await readFile(join(repo, "feature.txt"), "utf8");
    return text.split(/\r?\n/).filter((line) => line === marker).length;
  } catch {
    return 0;
  }
}

function crashWorker(repo: string, marker: string): void {
  const result = spawnSync(process.execPath, [...nodeArgs, "worker", repo, marker], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error("Code failure worker returned success; crash injection did not occur.");
  }
}

async function worker(repo: string, marker: string): Promise<never> {
  await appendFile(join(repo, "feature.txt"), `${marker}\n`, "utf8");
  git(repo, ["add", "feature.txt"]);
  git(repo, ["commit", "-q", "-m", `lhic-experiment:${marker}`]);
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

async function runBaseline(dir: string, trial: number): Promise<number> {
  const repo = join(dir, `baseline-${trial}`);
  await initRepo(repo);
  const marker = `feature-${trial}=enabled`;
  crashWorker(repo, marker);
  crashWorker(repo, marker);
  return markerCount(repo, marker);
}

async function runLhic(dir: string, trial: number): Promise<SurfaceTrialResult["lhic"]> {
  const repo = join(dir, `lhic-${trial}`);
  await initRepo(repo);
  const marker = `feature-${trial}=enabled`;
  const action: ResearchAction = {
    actionId: `code-edit-${trial}`,
    taskId: `code-task-${trial}`,
    surface: "code",
    tool: "git_commit",
    intent: "edit code and commit an isolated feature marker",
    target: "feature.txt",
    actionHash: deterministicHash(`code:${trial}`),
  };
  const approval = exactApproval(action);

  let dispatches = 0;
  let observations = 0;
  let verifications = 0;
  const ledgerFile = join(dir, `code-ledger-${trial}.json`);

  const makeAdapters = () => ({
    async execute(): Promise<ExecutionResult> {
      dispatches += 1;
      crashWorker(repo, marker);
      return {
        accepted: true,
        sideEffectOccurred: true,
        responseReceived: false,
        detail: "Git worker was killed after commit, before agent completion.",
      };
    },
    async observe() {
      observations += 1;
      return (await markerCount(repo, marker)) > 0
        ? "effect_present" as const
        : "effect_absent" as const;
    },
    async verify(): Promise<VerificationEvidence> {
      verifications += 1;
      const count = await markerCount(repo, marker);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const log = git(repo, ["log", "--format=%s", "--", "feature.txt"]);
      const matchingCommits = log
        .split(/\r?\n/)
        .filter((line) => line === `lhic-experiment:${marker}`).length;
      const artifact = `${head}\n${log}\nmarker-count=${count}`;
      const condition = "code postcondition: marker appears exactly once and exactly one experiment commit exists";
      return count === 1 && matchingCommits === 1
        ? passedEvidence(`code-evidence-${trial}`, condition, artifact)
        : failedEvidence(`code-evidence-${trial}`, condition, artifact);
    },
  });

  const ledger1 = new FileSideEffectLedger(ledgerFile);
  await ledger1.load();
  const kernel1 = new LhicResearchKernel(ledger1, makeAdapters());
  const first = await kernel1.run(action, approval);

  const ledger2 = new FileSideEffectLedger(ledgerFile);
  await ledger2.load();
  const kernel2 = new LhicResearchKernel(ledger2, makeAdapters());
  const recovered = await kernel2.run(action, approval);

  const finalCount = await markerCount(repo, marker);
  return {
    sideEffects: finalCount,
    duplicateSideEffects: Math.max(0, finalCount - 1),
    firstState: first.ledgerState,
    recoveredState: recovered.ledgerState,
    dispatches,
    observations,
    verifications,
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === "worker") {
    await worker(process.argv[3]!, process.argv[4]!);
  }

  const dir = await mkdtemp(join(tmpdir(), "lhic-code-real-"));
  try {
    const results: SurfaceTrialResult[] = [];
    for (let trial = 1; trial <= trialCount(); trial += 1) {
      const baselineSideEffects = await runBaseline(dir, trial);
      const lhic = await runLhic(dir, trial);
      results.push({
        surface: "code",
        trial,
        baseline: {
          sideEffects: baselineSideEffects,
          duplicateSideEffects: Math.max(0, baselineSideEffects - 1),
        },
        lhic,
      });
    }
    console.log(`LHIC_REAL_RESULT=${JSON.stringify(summarize("code", results))}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
