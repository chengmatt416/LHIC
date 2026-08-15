import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

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

interface BrowserFixture {
  server: Server;
  origin: string;
  reset(): void;
}

async function startFixture(): Promise<BrowserFixture> {
  let count = 0;
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/commit") {
      count += 1;
      res.writeHead(303, { Location: "/committed" });
      res.end();
      return;
    }

    if (req.method === "GET" && (req.url === "/" || req.url === "/committed")) {
      const body = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>LHIC Browser Fixture</title></head>
  <body>
    <main>
      <h1>LHIC Browser Failure Fixture</h1>
      <p>Committed orders: <span id="count">${count}</span></p>
      <form method="post" action="/commit">
        <button type="submit">Commit experimental order</button>
      </form>
    </main>
  </body>
</html>`;
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port.");
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    reset: () => {
      count = 0;
    },
  };
}

async function observeCount(origin: string): Promise<{ count: number; screenshot: Buffer }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    const text = await page.locator("#count").textContent();
    const count = Number.parseInt(text?.trim() ?? "", 10);
    if (!Number.isFinite(count)) throw new Error(`Invalid browser fixture count: ${text}`);
    const screenshot = await page.screenshot({ fullPage: true });
    return { count, screenshot };
  } finally {
    await browser.close();
  }
}

function crashWorker(origin: string): void {
  const result = spawnSync(process.execPath, [...nodeArgs, "worker", origin], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) {
    throw new Error("Browser failure worker returned success; crash injection did not occur.");
  }
}

async function worker(origin: string): Promise<never> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await Promise.all([
    page.waitForURL(`${origin}/committed`),
    page.getByRole("button", { name: "Commit experimental order" }).click(),
  ]);
  await browser.close();

  process.kill(process.pid, "SIGKILL");
  throw new Error("unreachable");
}

async function runTrial(fixture: BrowserFixture, trial: number): Promise<SurfaceTrialResult> {
  fixture.reset();

  crashWorker(fixture.origin);
  crashWorker(fixture.origin);
  const baseline = await observeCount(fixture.origin);
  const baselineSideEffects = baseline.count;

  fixture.reset();
  const dir = await mkdtemp(join(tmpdir(), "lhic-browser-real-"));
  try {
    const action: ResearchAction = {
      actionId: `browser-purchase-${trial}`,
      taskId: `browser-task-${trial}`,
      surface: "browser",
      tool: "click",
      intent: "purchase experimental item",
      target: "Commit experimental order",
      origin: fixture.origin,
      actionHash: deterministicHash(`browser:${trial}`),
    };
    const approval = exactApproval(action);

    let dispatches = 0;
    let observations = 0;
    let verifications = 0;

    const ledgerFile = join(dir, "ledger.json");
    const makeAdapters = () => ({
      async execute(): Promise<ExecutionResult> {
        dispatches += 1;
        crashWorker(fixture.origin);
        return {
          accepted: true,
          sideEffectOccurred: true,
          responseReceived: false,
          detail: "Chromium dispatcher was killed after the form commit.",
        };
      },
      async observe() {
        observations += 1;
        const observed = await observeCount(fixture.origin);
        return observed.count > 0 ? "effect_present" as const : "effect_absent" as const;
      },
      async verify(): Promise<VerificationEvidence> {
        verifications += 1;
        const observed = await observeCount(fixture.origin);
        const condition = "browser postcondition: exactly one committed order is visible";
        return observed.count === 1
          ? passedEvidence(`browser-evidence-${trial}`, condition, observed.screenshot)
          : failedEvidence(`browser-evidence-${trial}`, condition, observed.screenshot);
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
    const final = await observeCount(fixture.origin);

    return {
      surface: "browser",
      trial,
      baseline: {
        sideEffects: baselineSideEffects,
        duplicateSideEffects: Math.max(0, baselineSideEffects - 1),
      },
      lhic: {
        sideEffects: final.count,
        duplicateSideEffects: Math.max(0, final.count - 1),
        firstState: first.ledgerState,
        recoveredState: recovered.ledgerState,
        dispatches,
        observations,
        verifications,
      },
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "worker") {
    await worker(process.argv[3]!);
  }

  const fixture = await startFixture();
  try {
    const results: SurfaceTrialResult[] = [];
    for (let trial = 1; trial <= trialCount(); trial += 1) {
      results.push(await runTrial(fixture, trial));
    }
    const summary = summarize("browser", results);
    console.log(`LHIC_REAL_RESULT=${JSON.stringify(summary)}`);
  } finally {
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  }
}

await main();
