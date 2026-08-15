import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  waitFor,
  type SurfaceTrialResult,
} from "./common.ts";

const thisFile = fileURLToPath(import.meta.url);
const fixtureFile = fileURLToPath(new URL("./desktop-fixture.py", import.meta.url));
const nodeArgs = ["--experimental-strip-types", thisFile];

function xdotool(args: string[]): string {
  return execFileSync("xdotool", args, { encoding: "utf8" }).trim();
}

function windowId(token: string): string {
  const matches = xdotool(["search", "--name", token])
    .split(/\s+/)
    .filter(Boolean);
  if (matches.length === 0) throw new Error(`No desktop fixture window found for ${token}.`);
  return matches[0]!;
}

function windowTitle(token: string): string {
  return xdotool(["getwindowname", windowId(token)]);
}

function countFromTitle(title: string): number {
  const match = /count=(\d+)/.exec(title);
  if (!match) throw new Error(`Desktop title did not expose count: ${title}`);
  return Number.parseInt(match[1]!, 10);
}

async function startFixture(stateFile: string, token: string): Promise<ChildProcess> {
  const child = spawn("python3", [fixtureFile, stateFile, token], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(() => {
    try {
      return windowTitle(token).includes(token);
    } catch {
      return false;
    }
  }, 10_000, 100);
  return child;
}

async function stopFixture(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function crashWorker(token: string): void {
  const result = spawnSync(process.execPath, [...nodeArgs, "worker", token], {
    encoding: "utf8",
    timeout: 10_000,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error("Desktop failure worker returned success; crash injection did not occur.");
  }
}

async function worker(token: string): Promise<never> {
  const id = windowId(token);
  xdotool(["key", "--window", id, "ctrl+Return"]);
  await waitFor(() => countFromTitle(windowTitle(token)) >= 1, 3_000, 50);
  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

async function runBaseline(dir: string, trial: number): Promise<number> {
  const stateFile = join(dir, `baseline-${trial}.txt`);
  await writeFile(stateFile, "0", "utf8");
  const token = `baseline-${process.pid}-${trial}`;
  const fixture = await startFixture(stateFile, token);
  try {
    crashWorker(token);
    crashWorker(token);
    return countFromTitle(windowTitle(token));
  } finally {
    await stopFixture(fixture);
  }
}

async function runLhic(dir: string, trial: number): Promise<SurfaceTrialResult["lhic"]> {
  const stateFile = join(dir, `lhic-${trial}.txt`);
  await writeFile(stateFile, "0", "utf8");
  const token = `lhic-${process.pid}-${trial}`;
  const fixture = await startFixture(stateFile, token);
  try {
    const action: ResearchAction = {
      actionId: `desktop-action-${trial}`,
      taskId: `desktop-task-${trial}`,
      surface: "desktop",
      tool: "key",
      intent: "commit desktop experimental action",
      target: "Ctrl+Enter in LHIC Desktop Fixture",
      actionHash: deterministicHash(`desktop:${trial}`),
    };
    const approval = exactApproval(action);

    let dispatches = 0;
    let observations = 0;
    let verifications = 0;
    const ledgerFile = join(dir, `ledger-${trial}.json`);

    const makeAdapters = () => ({
      async execute(): Promise<ExecutionResult> {
        dispatches += 1;
        crashWorker(token);
        return {
          accepted: true,
          sideEffectOccurred: true,
          responseReceived: false,
          detail: "xdotool dispatcher was killed after the Tk action committed.",
        };
      },
      async observe() {
        observations += 1;
        return countFromTitle(windowTitle(token)) > 0
          ? "effect_present" as const
          : "effect_absent" as const;
      },
      async verify(): Promise<VerificationEvidence> {
        verifications += 1;
        const title = windowTitle(token);
        const count = countFromTitle(title);
        const condition = "desktop postcondition: exactly one committed action is visible in the native window";
        return count === 1
          ? passedEvidence(`desktop-evidence-${trial}`, condition, title)
          : failedEvidence(`desktop-evidence-${trial}`, condition, title);
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

    const finalCount = countFromTitle(windowTitle(token));
    const persisted = Number.parseInt((await readFile(stateFile, "utf8")).trim(), 10);
    if (persisted !== finalCount) {
      throw new Error(`Desktop observable state (${finalCount}) disagrees with persisted fixture state (${persisted}).`);
    }

    return {
      sideEffects: finalCount,
      duplicateSideEffects: Math.max(0, finalCount - 1),
      firstState: first.ledgerState,
      recoveredState: recovered.ledgerState,
      dispatches,
      observations,
      verifications,
    };
  } finally {
    await stopFixture(fixture);
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "worker") {
    await worker(process.argv[3]!);
  }

  if (!process.env.DISPLAY) {
    throw new Error("Desktop experiment requires an X11 DISPLAY. Use `xvfb-run -a npm run experiment:desktop`.");
  }

  const dir = await mkdtemp(join(tmpdir(), "lhic-desktop-real-"));
  try {
    const results: SurfaceTrialResult[] = [];
    for (let trial = 1; trial <= trialCount(); trial += 1) {
      const baselineSideEffects = await runBaseline(dir, trial);
      const lhic = await runLhic(dir, trial);
      results.push({
        surface: "desktop",
        trial,
        baseline: {
          sideEffects: baselineSideEffects,
          duplicateSideEffects: Math.max(0, baselineSideEffects - 1),
        },
        lhic,
      });
    }
    console.log(`LHIC_REAL_RESULT=${JSON.stringify(summarize("desktop", results))}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await main();
