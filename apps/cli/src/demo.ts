import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FastPathRouter,
  OpenAISlowPathProvider,
  parseUserIntent,
  type SlowPathRequest,
} from "@lhic/controller";
import { chromium } from "playwright";
import { testWebFlow } from "@lhic/skills";
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
 * Runs a credential-free local browser fixture, demonstrates the approval
 * boundary, and optionally exercises GPT-5.6 when its Slow Path is enabled.
 */
export async function runJudgeDemo(
  options: JudgeDemoOptions = {},
): Promise<JudgeDemoReport> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lhic-demo-"));
  const browser = await chromium.launch({ headless: !options.viewable });
  try {
    const page = await browser.newPage();
    await page.setContent(
      '<label>Search <input type="search"></label><p id="result"></p><script>document.querySelector("input").addEventListener("input", (event) => { document.querySelector("#result").textContent = event.target.value ? "Ready" : ""; });</script>',
    );
    const localResult = await testWebFlow(
      {
        page,
        verifier: new VerifierEngine({ page }),
        taskId: "judge-demo",
        traceFilePath: join(temporaryDirectory, "judge-demo.jsonl"),
      },
      {
        steps: [
          {
            type: "fill",
            intent: "enter the safe local fixture query",
            target: "input[type=search]",
            value: "release notes",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
        ],
        successConditions: [
          {
            type: "dom",
            description: "local result",
            params: { text: "Ready" },
          },
        ],
        stopBeforeHighRisk: true,
      },
    );

    const approvalDecision = new FastPathRouter().decide(
      { predictedIntent: "unknown", confidence: 0, evidence: [] },
      parseUserIntent("Delete the local demo record"),
    );
    const gpt56Response = await new OpenAISlowPathProvider().reason(
      createDemoSlowPathRequest(),
    );
    const approvalPassed = approvalDecision.path === "ask_user";

    const report = {
      passed: localResult.success && approvalPassed,
      localExecution: {
        passed: localResult.success,
        evidenceCount: localResult.evidence.length,
      },
      approvalGate: {
        passed: approvalPassed,
        path: approvalDecision.path,
      },
      gpt56: {
        enabled: process.env.OPENAI_SLOW_PATH_ENABLED === "true",
        decision: gpt56Response.decision,
        proposedActionCount: gpt56Response.proposedActions?.length ?? 0,
        message: gpt56Response.message,
      },
      notes: [
        "The local browser fixture uses no real account, credential, or external website.",
        "Set OPENAI_SLOW_PATH_ENABLED=true and OPENAI_API_KEY to include a live GPT-5.6 planning request; Fast Path remains model-free.",
      ],
    };
    if (options.viewable) await options.waitForClose?.();
    return report;
  } finally {
    await browser.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function createDemoSlowPathRequest(): SlowPathRequest {
  return {
    taskId: "judge-demo-openai",
    userIntent: {
      goal: "Find the release notes in the local fixture",
      constraints: { environment: "safe-local-demo" },
      riskLevel: "low",
      requiresConfirmation: false,
      missingInformation: [],
    },
    uiState: {
      surface: "browser",
      url: "http://lhic.local.test/demo",
      objects: [
        {
          id: "search",
          role: "textbox",
          label: "Search",
          source: "dom",
          selector: "input[type=search]",
        },
      ],
      signals: {},
      capturedAt: new Date().toISOString(),
    },
    recentTrace: [],
    reason: "complex_planning",
  };
}
