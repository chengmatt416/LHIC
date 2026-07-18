import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FastPathRouter,
  MultiPathTaskController,
  DurableTaskSummaryStore,
  parseUserIntent,
  readPathRoutingConfig,
} from "@lhic/controller";
import { BrowserStateObserver, PlaywrightDirectExecutor } from "@lhic/browser";
import { createMemoryDatabase } from "@lhic/memory";
import { chromium } from "playwright";
import { isBrowserSemanticAction } from "@lhic/schema";
import { VerifierEngine } from "@lhic/verifier";

export interface JudgeDemoReport {
  passed: boolean;
  localExecution: {
    passed: boolean;
    evidenceCount: number;
  };
  approvalGate: {
    passed: boolean;
    path: string;
  };
  controller: {
    profile: string;
    paths: string[];
    slowPathCalls: number;
    evidenceCount: number;
  };
  gpt56: {
    enabled: boolean;
    decision: string;
    proposedActionCount: number;
    message: string;
  };
  notes: string[];
}

export interface JudgeDemoOptions {
  viewable?: boolean;
  waitForClose?: () => Promise<void>;
}

/**
 * Runs a credential-free local browser fixture through the actual multi-path
 * controller and demonstrates the approval boundary. The safe demo always
 * remains Fast Path-only, even if a Slow Path provider is configured.
 */
export async function runJudgeDemo(
  options: JudgeDemoOptions = {},
): Promise<JudgeDemoReport> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lhic-demo-"));
  const database = createMemoryDatabase(
    join(temporaryDirectory, "state.sqlite"),
  );
  const summaryStore = new DurableTaskSummaryStore(database);
  const browser = await chromium.launch({ headless: !options.viewable });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<label>Search <input type="search"></label><p id="result"></p><script>document.querySelector("input").addEventListener("input", (event) => { document.querySelector("#result").textContent = event.target.value ? "Ready" : ""; });</script>',
    );
    const taskId = "judge-demo";
    const traceFilePath = join(temporaryDirectory, "judge-demo.jsonl");
    const config = readPathRoutingConfig();
    const intent = parseUserIntent("Search for release notes");
    const observer = new BrowserStateObserver(page);
    const verifier = new VerifierEngine({ page });
    const executor = new PlaywrightDirectExecutor(page, {
      taskId,
      traceFilePath,
    });
    const controllerResult = await new MultiPathTaskController({
      taskId,
      intent,
      prediction: {
        predictedIntent: "search",
        skillName: "search",
        confidence: 0.9,
        evidence: ["The local fixture exposes one search field."],
      },
      profile: "fast_only",
      config: { ...config, defaultProfile: "fast_only" },
      summaryStore,
      observe: async () => observer.observe(),
      resolveLocalPlan: async () => [
        {
          type: "fill",
          intent: "enter the safe local fixture query",
          target: "input[type=search]",
          value: "release notes",
          methodPreference: ["dom"],
          riskLevel: "low",
        },
      ],
      executor: {
        execute: async (action) => {
          if (!isBrowserSemanticAction(action)) {
            return {
              execution: {
                success: false,
                method: "dom",
                latencyMs: 0,
                evidence: [],
                error: "The safe browser demo only permits browser actions.",
              },
              verification: {
                success: false,
                evidence: [],
                error: "The action was not eligible for the browser verifier.",
              },
            };
          }
          const execution = await executor.execute(action);
          const verification = execution.success
            ? await verifier.verify({
                type: "dom",
                description: "local result",
                params: { text: "Ready" },
              })
            : {
                success: false,
                evidence: [],
                error: "The local fixture action did not execute.",
              };
          return { execution, verification };
        },
      },
    }).run();
    observer.dispose();

    const approvalDecision = new FastPathRouter().decide(
      { predictedIntent: "unknown", confidence: 0, evidence: [] },
      parseUserIntent("Delete the local demo record"),
    );
    const approvalPassed = approvalDecision.path === "ask_user";
    const evidenceCount = controllerResult.outcomes.flatMap(
      (outcome) => outcome.verification.evidence,
    ).length;

    const report = {
      passed: controllerResult.status === "completed" && approvalPassed,
      localExecution: {
        passed: controllerResult.status === "completed",
        evidenceCount,
      },
      approvalGate: {
        passed: approvalPassed,
        path: approvalDecision.path,
      },
      controller: {
        profile: "fast_only",
        paths: controllerResult.routes.map((route) => route.path),
        slowPathCalls: controllerResult.budget.slowPathCalls,
        evidenceCount,
      },
      gpt56: {
        enabled: false,
        decision: "blocked",
        proposedActionCount: 0,
        message:
          "The safe Fast Path demo never invokes a model provider. Enable a budgeted planner in a separate balanced or deliberative task.",
      },
      notes: [
        "The local browser fixture uses no real account, credential, or external website.",
        "The controller records stage routes and verifier evidence; this Fast Path run uses 0 model calls, 0 MCP calls, and 0 runtime network calls.",
      ],
    };
    if (options.viewable) await options.waitForClose?.();
    return report;
  } finally {
    await browser.close();
    database.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
