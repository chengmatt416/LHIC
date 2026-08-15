import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright";

import { LhicResearchKernel, type KernelAdapters } from "../../src/kernel.ts";
import { FileSideEffectLedger } from "../../src/ledger.ts";
import type { AgentActionReceipt, ExecutionResult, ResearchAction, VerificationEvidence } from "../../src/model.ts";
import {
  deterministicHash,
  exactApproval,
  failedEvidence,
  passedEvidence,
  waitFor,
} from "./common.ts";

type Surface = "browser" | "desktop" | "code";
type FaultMode =
  | "pre_dispatch_failure"
  | "post_commit_lost_response"
  | "delayed_visibility"
  | "partial_postcondition"
  | "duplicate_delivery"
  | "late_completion_after_recovery";

interface SurfaceHarness {
  readonly surface: Surface;
  commit(): Promise<void>;
  effectCount(): Promise<number>;
  postconditionComplete(): Promise<boolean>;
  artifact(): Promise<string | Buffer>;
  close(): Promise<void>;
}

interface TrialSchedule {
  seed: number;
  visibilityDelayMs: number;
  pollIntervalMs: number;
}

interface CampaignTrialResult {
  surface: Surface;
  mode: FaultMode;
  trial: number;
  seed: number;
  visibilityDelayMs: number;
  pollIntervalMs: number;
  firstReceiptState: string;
  finalReceiptState: string;
  durableLedgerState: string | undefined;
  dispatches: number;
  observations: number;
  verifications: number;
  sideEffects: number;
  duplicateSideEffects: number;
  elapsedMs: number;
  passed: boolean;
  failure?: string;
}

interface CampaignSummary {
  schemaVersion: "lhic-randomized-cross-surface-v1";
  generatedAt: string;
  seed: string;
  trialsPerModePerSurface: number;
  totalTrials: number;
  passed: number;
  failed: number;
  duplicateSideEffects: number;
  results: CampaignTrialResult[];
}

const fixtureFile = fileURLToPath(new URL("./desktop-fixture.py", import.meta.url));
const surfaces: Surface[] = ["browser", "desktop", "code"];
const modes: FaultMode[] = [
  "pre_dispatch_failure",
  "post_commit_lost_response",
  "delayed_visibility",
  "partial_postcondition",
  "duplicate_delivery",
  "late_completion_after_recovery",
];

const campaignSeed = process.env.LHIC_CAMPAIGN_SEED ?? "2026-08-15";
const parsedTrials = Number.parseInt(process.env.LHIC_CAMPAIGN_TRIALS ?? "3", 10);
const trialsPerMode = Number.isSafeInteger(parsedTrials) && parsedTrials > 0 ? parsedTrials : 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedNumber(label: string): number {
  return Number.parseInt(deterministicHash(`${campaignSeed}:${label}`).slice(0, 8), 16) >>> 0;
}

function scheduleFor(surface: Surface, mode: FaultMode, trial: number): TrialSchedule {
  const seed = seedNumber(`${surface}:${mode}:${trial}`);
  return {
    seed,
    visibilityDelayMs: 40 + (seed % 181),
    pollIntervalMs: 20 + ((seed >>> 8) % 41),
  };
}

function xdotool(args: string[]): string {
  return execFileSync("xdotool", args, { encoding: "utf8" }).trim();
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

async function startBrowserHarness(partial: boolean): Promise<SurfaceHarness> {
  let count = 0;
  let status: "complete" | "partial" = "complete";
  const server: Server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/commit") {
      count += 1;
      status = partial ? "partial" : "complete";
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(`<!doctype html><html><body><main>
        <div id="count">${count}</div><div id="status">${status}</div>
        <form method="post" action="/commit"><button type="submit">Commit randomized action</button></form>
      </main></body></html>`);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Browser campaign fixture failed to bind.");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser: Browser = await chromium.launch({ headless: true });
  const page: Page = await browser.newPage();

  async function refresh(): Promise<void> {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
  }

  return {
    surface: "browser",
    async commit() {
      await refresh();
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.getByRole("button", { name: "Commit randomized action" }).click(),
      ]);
    },
    async effectCount() {
      await refresh();
      return Number.parseInt((await page.locator("#count").textContent())?.trim() ?? "0", 10);
    },
    async postconditionComplete() {
      await refresh();
      return (await page.locator("#status").textContent())?.trim() === "complete";
    },
    async artifact() {
      await refresh();
      return page.screenshot({ fullPage: true });
    },
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function desktopWindowId(token: string): string {
  const ids = xdotool(["search", "--name", token]).split(/\s+/).filter(Boolean);
  if (ids.length === 0) throw new Error(`No desktop campaign window found for ${token}.`);
  return ids[0]!;
}

function desktopTitle(token: string): string {
  return xdotool(["getwindowname", desktopWindowId(token)]);
}

function desktopCount(title: string): number {
  const match = /count=(\d+)/.exec(title);
  if (!match) throw new Error(`Desktop campaign title missing count: ${title}`);
  return Number.parseInt(match[1]!, 10);
}

async function stopChild(child: ChildProcess): Promise<void> {
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

async function startDesktopHarness(dir: string, token: string, partial: boolean): Promise<SurfaceHarness> {
  if (!process.env.DISPLAY) throw new Error("Randomized desktop campaign requires DISPLAY / xvfb-run.");
  const stateFile = join(dir, `${token}.txt`);
  await writeFile(stateFile, "0", "utf8");
  const child = spawn("python3", [fixtureFile, stateFile, token, partial ? "partial" : "complete"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  await waitFor(() => {
    try {
      return desktopTitle(token).includes(token);
    } catch {
      return false;
    }
  }, 10_000, 100);

  return {
    surface: "desktop",
    async commit() {
      const id = desktopWindowId(token);
      const before = desktopCount(desktopTitle(token));
      xdotool(["mousemove", "--window", id, "230", "160", "click", "1"]);
      await waitFor(() => desktopCount(desktopTitle(token)) > before, 3_000, 50);
    },
    async effectCount() {
      return desktopCount(desktopTitle(token));
    },
    async postconditionComplete() {
      return /status=complete/.test(desktopTitle(token));
    },
    async artifact() {
      const persisted = (await readFile(stateFile, "utf8")).trim();
      return `${desktopTitle(token)}\npersisted=${persisted}`;
    },
    async close() {
      await stopChild(child);
    },
  };
}

async function startCodeHarness(dir: string, token: string, partial: boolean): Promise<SurfaceHarness> {
  const repo = join(dir, token);
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "LHIC Randomized Campaign"]);
  git(repo, ["config", "user.email", "lhic-randomized@example.invalid"]);
  await writeFile(join(repo, "README.md"), "# randomized campaign\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);
  const marker = `${token}=enabled`;

  async function markerCount(): Promise<number> {
    try {
      const text = await readFile(join(repo, "feature.txt"), "utf8");
      return text.split(/\r?\n/).filter((line) => line === marker).length;
    } catch {
      return 0;
    }
  }

  return {
    surface: "code",
    async commit() {
      await appendFile(join(repo, "feature.txt"), `${marker}\n`, "utf8");
      if (!partial) await writeFile(join(repo, "postcondition.txt"), "complete\n", "utf8");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", `randomized:${token}`]);
    },
    effectCount: markerCount,
    async postconditionComplete() {
      try {
        return (await readFile(join(repo, "postcondition.txt"), "utf8")).trim() === "complete";
      } catch {
        return false;
      }
    },
    async artifact() {
      const log = git(repo, ["log", "--format=%H %s"]);
      const count = await markerCount();
      let postcondition = "missing";
      try {
        postcondition = (await readFile(join(repo, "postcondition.txt"), "utf8")).trim();
      } catch {
        // expected for partial-postcondition injection
      }
      return `${log}\nmarkerCount=${count}\npostcondition=${postcondition}`;
    },
    async close() {},
  };
}

async function makeHarness(
  surface: Surface,
  dir: string,
  token: string,
  partial: boolean,
): Promise<SurfaceHarness> {
  if (surface === "browser") return startBrowserHarness(partial);
  if (surface === "desktop") return startDesktopHarness(dir, token, partial);
  return startCodeHarness(dir, token, partial);
}

async function runKernel(
  ledgerFile: string,
  action: ResearchAction,
  approval: ReturnType<typeof exactApproval>,
  adapters: KernelAdapters,
): Promise<{ receipt: AgentActionReceipt; ledger: FileSideEffectLedger }> {
  const ledger = new FileSideEffectLedger(ledgerFile);
  await ledger.load();
  const kernel = new LhicResearchKernel(ledger, adapters);
  return { receipt: await kernel.run(action, approval), ledger };
}

function expectedDurableState(mode: FaultMode): string {
  if (mode === "pre_dispatch_failure") return "needs_resolution";
  if (mode === "partial_postcondition") return "executed";
  return "verified";
}

async function runTrial(surface: Surface, mode: FaultMode, trial: number): Promise<CampaignTrialResult> {
  const schedule = scheduleFor(surface, mode, trial);
  const dir = await mkdtemp(join(tmpdir(), `lhic-randomized-${surface}-`));
  const token = `rand-${surface}-${mode}-${trial}-${schedule.seed.toString(16)}`.replace(/_/g, "-");
  const partial = mode === "partial_postcondition";
  const harness = await makeHarness(surface, dir, token, partial);
  const startedAt = Date.now();
  let committedAt: number | undefined;
  let dispatches = 0;
  let observations = 0;
  let verifications = 0;

  try {
    const action: ResearchAction = {
      actionId: `randomized:${surface}:${mode}:${trial}`,
      taskId: `randomized-task:${surface}:${mode}:${trial}`,
      surface,
      tool: surface === "code" ? "git_commit" : "click",
      intent: `randomized failure campaign ${mode}`,
      target: token,
      ...(surface === "browser" ? { origin: "http://127.0.0.1" } : {}),
      actionHash: deterministicHash(`randomized:${surface}:${mode}:${trial}:${schedule.seed}`),
    };
    const approval = exactApproval(action);
    const ledgerFile = join(dir, "ledger.json");

    const adapters: KernelAdapters = {
      async execute(): Promise<ExecutionResult> {
        dispatches += 1;
        if (mode === "pre_dispatch_failure") {
          return {
            accepted: true,
            sideEffectOccurred: false,
            responseReceived: false,
            detail: "Injected failure after durable ambiguity persistence but before physical dispatch.",
          };
        }
        await harness.commit();
        committedAt = Date.now();
        return {
          accepted: true,
          sideEffectOccurred: true,
          responseReceived: mode === "duplicate_delivery",
          detail: mode === "duplicate_delivery"
            ? "Executor completion arrived normally; duplicate logical delivery follows."
            : "Injected lost completion after external commit.",
        };
      },
      async observe() {
        observations += 1;
        if (
          mode === "delayed_visibility" &&
          committedAt !== undefined &&
          Date.now() - committedAt < schedule.visibilityDelayMs
        ) {
          return "inconclusive" as const;
        }
        return (await harness.effectCount()) > 0
          ? "effect_present" as const
          : "effect_absent" as const;
      },
      async verify(): Promise<VerificationEvidence> {
        verifications += 1;
        const effects = await harness.effectCount();
        const complete = await harness.postconditionComplete();
        const artifact = await harness.artifact();
        const condition = `${surface} randomized postcondition: exactly one side effect and complete external state`;
        return effects === 1 && complete
          ? passedEvidence(`randomized:${surface}:${mode}:${trial}:${verifications}`, condition, artifact)
          : failedEvidence(`randomized:${surface}:${mode}:${trial}:${verifications}`, condition, artifact);
      },
    };

    const firstRun = await runKernel(ledgerFile, action, approval, adapters);
    let firstReceipt = firstRun.receipt;
    let finalReceipt = firstReceipt;

    if (mode === "pre_dispatch_failure" || mode === "post_commit_lost_response") {
      finalReceipt = (await runKernel(ledgerFile, action, approval, adapters)).receipt;
    } else if (mode === "delayed_visibility") {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await sleep(schedule.pollIntervalMs);
        finalReceipt = (await runKernel(ledgerFile, action, approval, adapters)).receipt;
        const probe = new FileSideEffectLedger(ledgerFile);
        await probe.load();
        if (probe.get(action.actionId)?.state === "verified") break;
      }
    } else if (mode === "partial_postcondition") {
      finalReceipt = (await runKernel(ledgerFile, action, approval, adapters)).receipt;
      // Re-run once more from executed to prove failed verification does not trigger replay.
      finalReceipt = (await runKernel(ledgerFile, action, approval, adapters)).receipt;
    } else if (mode === "duplicate_delivery") {
      // Duplicate logical delivery after an already verified first execution.
      finalReceipt = (await runKernel(ledgerFile, action, approval, adapters)).receipt;
    } else if (mode === "late_completion_after_recovery") {
      // First recover the lost completion, then deliver the same logical action again as a stale/late completion path.
      finalReceipt = (await runKernel(ledgerFile, action, approval, adapters)).receipt;
      finalReceipt = (await runKernel(ledgerFile, action, approval, adapters)).receipt;
    }

    const finalLedger = new FileSideEffectLedger(ledgerFile);
    await finalLedger.load();
    const durableLedgerState = finalLedger.get(action.actionId)?.state;
    const sideEffects = await harness.effectCount();
    const duplicateSideEffects = Math.max(0, sideEffects - 1);
    const expectedState = expectedDurableState(mode);
    const expectedEffects = mode === "pre_dispatch_failure" ? 0 : 1;
    const passed =
      durableLedgerState === expectedState &&
      dispatches === 1 &&
      sideEffects === expectedEffects &&
      duplicateSideEffects === 0 &&
      (mode !== "delayed_visibility" || observations >= 2) &&
      (mode !== "partial_postcondition" || verifications >= 2);

    return {
      surface,
      mode,
      trial,
      seed: schedule.seed,
      visibilityDelayMs: schedule.visibilityDelayMs,
      pollIntervalMs: schedule.pollIntervalMs,
      firstReceiptState: firstReceipt.ledgerState,
      finalReceiptState: finalReceipt.ledgerState,
      durableLedgerState,
      dispatches,
      observations,
      verifications,
      sideEffects,
      duplicateSideEffects,
      elapsedMs: Date.now() - startedAt,
      passed,
      ...(!passed
        ? {
            failure: `expected durable=${expectedState}, effects=${expectedEffects}, dispatches=1, duplicates=0`,
          }
        : {}),
    };
  } catch (error) {
    return {
      surface,
      mode,
      trial,
      seed: schedule.seed,
      visibilityDelayMs: schedule.visibilityDelayMs,
      pollIntervalMs: schedule.pollIntervalMs,
      firstReceiptState: "error",
      finalReceiptState: "error",
      durableLedgerState: undefined,
      dispatches,
      observations,
      verifications,
      sideEffects: await harness.effectCount().catch(() => -1),
      duplicateSideEffects: 0,
      elapsedMs: Date.now() - startedAt,
      passed: false,
      failure: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await harness.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}

const results: CampaignTrialResult[] = [];
for (const surface of surfaces) {
  for (const mode of modes) {
    for (let trial = 1; trial <= trialsPerMode; trial += 1) {
      const result = await runTrial(surface, mode, trial);
      results.push(result);
      console.log(`LHIC_RANDOMIZED_TRIAL=${JSON.stringify(result)}`);
    }
  }
}

const summary: CampaignSummary = {
  schemaVersion: "lhic-randomized-cross-surface-v1",
  generatedAt: new Date().toISOString(),
  seed: campaignSeed,
  trialsPerModePerSurface: trialsPerMode,
  totalTrials: results.length,
  passed: results.filter((result) => result.passed).length,
  failed: results.filter((result) => !result.passed).length,
  duplicateSideEffects: results.reduce((sum, result) => sum + Math.max(0, result.duplicateSideEffects), 0),
  results,
};

await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/randomized-cross-surface-results.json",
  `${JSON.stringify(summary, null, 2)}\n`,
  "utf8",
);
console.log(`LHIC_RANDOMIZED_CAMPAIGN=${JSON.stringify(summary)}`);

if (summary.failed > 0) {
  const failures = results.filter((result) => !result.passed);
  throw new Error(
    `Randomized cross-surface acceptance failed for ${summary.failed}/${summary.totalTrials} trials:\n` +
      failures.map((failure) => `- ${failure.surface}/${failure.mode}/${failure.trial}: ${failure.failure ?? "acceptance mismatch"}`).join("\n"),
  );
}
