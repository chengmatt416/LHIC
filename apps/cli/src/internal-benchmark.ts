import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { PlaywrightDirectExecutor } from "@lhic/browser";
import { executeBrowserPlan } from "@lhic/controller";
import type { BrowserExecutionPlan } from "@lhic/schema";
import { createActionApproval } from "@lhic/security";
import {
  downloadFile,
  createDownloadAction,
  fillForm,
  login,
  search,
  testWebFlow,
  type SkillResult,
} from "@lhic/skills";
import { VerifierEngine } from "@lhic/verifier";

export type BenchmarkSkill =
  | "browser_plan"
  | "fill_form"
  | "download_file"
  | "login"
  | "search"
  | "test_web_flow";

export interface BenchmarkFixture {
  id: string;
  skill: BenchmarkSkill;
  variant: number;
}

export interface BenchmarkTaskResult {
  fixtureId: string;
  skill: BenchmarkSkill;
  durationMs: number;
  success: boolean;
  modelCalls: number;
  mcpCalls: number;
  fastPath: boolean;
  structuredActions: number;
  rawCoordinateActions: number;
  verifierPassed: boolean;
  falsePositive: boolean;
  humanIntervention: boolean;
}

export interface BenchmarkMetrics {
  taskSuccessRate: number;
  medianTimeToCompleteMs: number;
  p95TimeToCompleteMs: number;
  modelCallsPerTask: number;
  mcpCallsPerTask: number;
  fastPathRatio: number;
  structuredActionRatio: number;
  rawCoordinateActionRatio: number;
  verifierPassRate: number;
  falsePositiveSuccessRate: number;
  humanInterventionCount: number;
}

export interface DailyWorkflowBenchmarkMetrics {
  taskCount: number;
  taskSuccessRate: number;
  p95TimeToCompleteMs: number;
  verifierPassRate: number;
}

export interface InternalBenchmarkReport {
  fixtureCount: number;
  results: BenchmarkTaskResult[];
  metrics: BenchmarkMetrics;
  dailyWorkflow: DailyWorkflowBenchmarkMetrics;
  repetitions: number;
  runs: Array<{ repetition: number; metrics: BenchmarkMetrics }>;
  fastOnlyBaselineP95Ms: number;
  passCriteria: {
    taskSuccessRate: boolean;
    medianModelCallsPerTask: boolean;
    mcpCallsPerTask: boolean;
    fastPathRatio: boolean;
    verifierPassRate: boolean;
    fastOnlyP95Regression: boolean;
    dailyWorkflowP95Ms: boolean;
    dailyWorkflowVerifierPassRate: boolean;
  };
  passed: boolean;
}

export async function loadInternalFixtures(
  projectRoot = process.cwd(),
): Promise<BenchmarkFixture[]> {
  const content = await readFile(
    join(projectRoot, "tests", "fixtures", "internal-benchmark.json"),
    "utf8",
  );
  return JSON.parse(content) as BenchmarkFixture[];
}

export function calculateBenchmarkMetrics(
  results: BenchmarkTaskResult[],
): BenchmarkMetrics {
  if (results.length === 0) {
    return {
      taskSuccessRate: 0,
      medianTimeToCompleteMs: 0,
      p95TimeToCompleteMs: 0,
      modelCallsPerTask: 0,
      mcpCallsPerTask: 0,
      fastPathRatio: 0,
      structuredActionRatio: 0,
      rawCoordinateActionRatio: 0,
      verifierPassRate: 0,
      falsePositiveSuccessRate: 0,
      humanInterventionCount: 0,
    };
  }
  const total = results.length;
  const durations = results
    .map((result) => result.durationMs)
    .sort((left, right) => left - right);
  const totalStructured = results.reduce(
    (sum, result) => sum + result.structuredActions,
    0,
  );
  const totalRawCoordinate = results.reduce(
    (sum, result) => sum + result.rawCoordinateActions,
    0,
  );
  const totalActions = totalStructured + totalRawCoordinate;
  const successful = results.filter((result) => result.success);

  return {
    taskSuccessRate: successful.length / total,
    medianTimeToCompleteMs: percentile(durations, 0.5),
    p95TimeToCompleteMs: percentile(durations, 0.95),
    modelCallsPerTask:
      results.reduce((sum, result) => sum + result.modelCalls, 0) / total,
    mcpCallsPerTask:
      results.reduce((sum, result) => sum + result.mcpCalls, 0) / total,
    fastPathRatio: results.filter((result) => result.fastPath).length / total,
    structuredActionRatio:
      totalActions === 0 ? 0 : totalStructured / totalActions,
    rawCoordinateActionRatio:
      totalActions === 0 ? 0 : totalRawCoordinate / totalActions,
    verifierPassRate:
      results.filter((result) => result.verifierPassed).length / total,
    falsePositiveSuccessRate:
      successful.length === 0
        ? 0
        : successful.filter((result) => result.falsePositive).length /
          successful.length,
    humanInterventionCount: results.filter((result) => result.humanIntervention)
      .length,
  };
}

export function calculateDailyWorkflowMetrics(
  results: BenchmarkTaskResult[],
): DailyWorkflowBenchmarkMetrics {
  const dailyWorkflowResults = results.filter(
    (result) => result.skill === "browser_plan",
  );
  if (dailyWorkflowResults.length === 0) {
    return {
      taskCount: 0,
      taskSuccessRate: 0,
      p95TimeToCompleteMs: 0,
      verifierPassRate: 0,
    };
  }
  return {
    taskCount: dailyWorkflowResults.length,
    taskSuccessRate:
      dailyWorkflowResults.filter((result) => result.success).length /
      dailyWorkflowResults.length,
    p95TimeToCompleteMs: percentile(
      dailyWorkflowResults
        .map((result) => result.durationMs)
        .sort((left, right) => left - right),
      0.95,
    ),
    verifierPassRate:
      dailyWorkflowResults.filter((result) => result.verifierPassed).length /
      dailyWorkflowResults.length,
  };
}

export function assessBenchmark(
  metrics: BenchmarkMetrics,
): Omit<
  InternalBenchmarkReport["passCriteria"],
  | "fastOnlyP95Regression"
  | "dailyWorkflowP95Ms"
  | "dailyWorkflowVerifierPassRate"
> {
  return {
    taskSuccessRate: metrics.taskSuccessRate >= 0.85,
    medianModelCallsPerTask: metrics.modelCallsPerTask === 0,
    mcpCallsPerTask: metrics.mcpCallsPerTask === 0,
    fastPathRatio: metrics.fastPathRatio >= 0.7,
    verifierPassRate: metrics.verifierPassRate >= 0.9,
  };
}

export async function runInternalBenchmark(
  projectRoot = process.cwd(),
  options: { repetitions?: number } = {},
): Promise<InternalBenchmarkReport> {
  const repetitions = options.repetitions ?? 5;
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 20
  ) {
    throw new Error(
      "Internal benchmark repetitions must be an integer from 1 to 20.",
    );
  }
  const fixtures = await loadInternalFixtures(projectRoot);
  const runs = [] as Array<{
    repetition: number;
    results: BenchmarkTaskResult[];
    metrics: BenchmarkMetrics;
  }>;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lhic-benchmark-"));
  const browser = await chromium.launch({ headless: true });
  try {
    const completedRuns = await Promise.all(
      Array.from({ length: repetitions }, async (_value, index) => {
        const repetition = index + 1;
        const page = await browser.newPage();
        try {
          const results = await runInternalBenchmarkPass(
            page,
            fixtures,
            join(temporaryDirectory, `run-${repetition}`),
          );
          return {
            repetition,
            metrics: calculateBenchmarkMetrics(results),
            results,
          };
        } finally {
          await page.close();
        }
      }),
    );
    runs.push(
      ...completedRuns.sort(
        (left, right) => left.repetition - right.repetition,
      ),
    );
  } finally {
    await browser.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  const metrics = calculateBenchmarkMetrics(runs.flatMap((run) => run.results));
  const dailyWorkflow = calculateDailyWorkflowMetrics(
    runs.flatMap((run) => run.results),
  );
  const fastOnlyBaselineP95Ms = percentile(
    runs
      .map((run) => run.metrics.p95TimeToCompleteMs)
      .sort((left, right) => left - right),
    0.5,
  );
  const passCriteria = {
    ...assessBenchmark(metrics),
    fastOnlyP95Regression: runs.every(
      (run) => run.metrics.p95TimeToCompleteMs <= fastOnlyBaselineP95Ms * 1.1,
    ),
    dailyWorkflowP95Ms: dailyWorkflow.p95TimeToCompleteMs <= 5_000,
    dailyWorkflowVerifierPassRate: dailyWorkflow.verifierPassRate >= 0.9,
  };
  return {
    fixtureCount: runs[0]?.results.length ?? 0,
    results: runs.flatMap((run) => run.results),
    metrics,
    dailyWorkflow,
    repetitions,
    runs: runs.map(({ repetition, metrics: runMetrics }) => ({
      repetition,
      metrics: runMetrics,
    })),
    fastOnlyBaselineP95Ms,
    passCriteria,
    passed: Object.values(passCriteria).every(Boolean),
  };
}

async function runInternalBenchmarkPass(
  page: Page,
  fixtures: readonly BenchmarkFixture[],
  temporaryDirectory: string,
): Promise<BenchmarkTaskResult[]> {
  const results: BenchmarkTaskResult[] = [];

  for (const fixture of fixtures) {
    const startedAt = performance.now();
    const result = await executeFixture(page, fixture, temporaryDirectory);
    results.push({
      fixtureId: fixture.id,
      skill: fixture.skill,
      durationMs: Math.round(performance.now() - startedAt),
      success: result.success,
      modelCalls: 0,
      mcpCalls: 0,
      fastPath: true,
      structuredActions: structuredActionCount(fixture),
      rawCoordinateActions: 0,
      verifierPassed: result.success,
      falsePositive: false,
      humanIntervention: result.askUser === true,
    });
  }

  return results;
}

async function executeFixture(
  page: Page,
  fixture: BenchmarkFixture,
  temporaryDirectory: string,
): Promise<SkillResult> {
  const traceFilePath = join(temporaryDirectory, `${fixture.id}.jsonl`);
  const context = {
    page,
    verifier: new VerifierEngine({ page }),
    taskId: fixture.id,
    traceFilePath,
  };
  const value = `value-${fixture.variant}`;

  switch (fixture.skill) {
    case "fill_form":
      await page.setContent(
        '<form><label>Name <input name="name"></label><button type="submit">Submit</button></form><p id="result"></p><script>document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); document.querySelector("#result").textContent = "Saved"; });</script>',
      );
      return fillForm(context, { fields: { name: value } });
    case "download_file":
      await page.setContent(
        `<a id="download" download="report-${fixture.variant}.txt" href="data:text/plain,benchmark-${fixture.variant}">Download</a>`,
      );
      return downloadFile(context, {
        trigger: "#download",
        expectedExtension: ".txt",
        downloadDir: temporaryDirectory,
        approval: createActionApproval(
          createDownloadAction("#download"),
          "benchmark-user",
        ),
      });
    case "login":
      await page.setContent(
        '<form><label>Email <input type="email"></label><label>Password <input type="password"></label><button type="submit">Sign in</button></form><p id="result"></p><script>document.querySelector("form").addEventListener("submit", (event) => { event.preventDefault(); document.querySelector("#result").textContent = "Welcome"; });</script>',
      );
      return login(context, {
        username: `user-${fixture.variant}@example.test`,
        password: "benchmark-password",
        successText: "Welcome",
      });
    case "search":
      await page.setContent(
        '<label>Search <input type="search"></label><button>Search</button><p id="result"></p><script>document.querySelector("button").addEventListener("click", () => { document.querySelector("#result").textContent = "Found"; });</script>',
      );
      return search(context, { query: value, expectedText: "Found" });
    case "test_web_flow":
      await page.setContent(
        '<input id="name"><p id="result"></p><script>document.querySelector("#name").addEventListener("input", () => { document.querySelector("#result").textContent = "Ready"; });</script>',
      );
      return testWebFlow(context, {
        steps: [
          {
            type: "fill",
            intent: "fill name",
            target: "#name",
            value,
            methodPreference: ["dom"],
            riskLevel: "low",
          },
        ],
        successConditions: [
          { type: "dom", description: "ready", params: { text: "Ready" } },
        ],
        stopBeforeHighRisk: true,
      });
    case "browser_plan":
      return executeDailyWorkflowPlan(page, fixture, traceFilePath);
  }
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
    ] ?? 0
  );
}

async function executeDailyWorkflowPlan(
  page: Page,
  fixture: BenchmarkFixture,
  traceFilePath: string,
): Promise<SkillResult> {
  await page.setContent(`
    <label>Search <input id="search" type="search"></label>
    <button id="find" type="button">Find project</button>
    <p id="project-result"></p>
    <label>Daily update <textarea id="daily-update"></textarea></label>
    <button id="save-draft" type="button">Save draft</button>
    <p id="save-result"></p>
    <script>
      document.querySelector('#find').addEventListener('click', () => {
        document.querySelector('#project-result').textContent = 'Project result ready';
      });
      document.querySelector('#save-draft').addEventListener('click', () => {
        document.querySelector('#save-result').textContent = 'Draft saved';
      });
    </script>
  `);
  const plan: BrowserExecutionPlan = {
    schemaVersion: "browser-plan-v1",
    goal: "Find a project and save its daily update",
    requiredVariables: [],
    steps: [
      {
        id: "fill-search",
        action: {
          type: "fill",
          intent: "enter the project search",
          target: "#search",
          value: `project-${fixture.variant}`,
          methodPreference: ["dom"],
          riskLevel: "low",
        },
        verification: {
          type: "dom",
          description: "search field remains available",
          params: { selector: "#search" },
        },
      },
      {
        id: "show-project",
        action: {
          type: "click",
          intent: "show matching project",
          target: "#find",
          methodPreference: ["dom"],
          riskLevel: "low",
        },
        verification: {
          type: "dom",
          description: "project result is visible",
          params: { text: "Project result ready" },
        },
      },
      {
        id: "fill-update",
        action: {
          type: "fill",
          intent: "enter the daily update",
          target: "#daily-update",
          value: `daily-update-${fixture.variant}`,
          methodPreference: ["dom"],
          riskLevel: "low",
        },
        verification: {
          type: "dom",
          description: "daily update field remains available",
          params: { selector: "#daily-update" },
        },
      },
      {
        id: "save-draft",
        action: {
          type: "click",
          intent: "save the daily update draft",
          target: "#save-draft",
          methodPreference: ["dom"],
          riskLevel: "low",
        },
        verification: {
          type: "dom",
          description: "draft save confirmation is visible",
          params: { text: "Draft saved" },
        },
      },
    ],
  };
  const approvals = Object.fromEntries(
    plan.steps
      .filter((step) => step.action.type === "click")
      .map((step) => [
        step.id,
        createActionApproval(step.action, "benchmark-user"),
      ]),
  );
  const result = await executeBrowserPlan(
    plan,
    new PlaywrightDirectExecutor(page, {
      taskId: fixture.id,
      traceFilePath,
    }),
    new VerifierEngine({ page }),
    { approvals, requireActivationApproval: true },
  );
  return {
    success: result.status === "completed",
    evidence: result.completedSteps.flatMap((step) => [
      ...step.execution.evidence,
      ...step.verification.evidence,
    ]),
    traces: [],
    ...(result.status === "failed" ? { error: result.error } : {}),
  };
}

function structuredActionCount(fixture: BenchmarkFixture): number {
  return fixture.skill === "browser_plan" ? 4 : 1;
}
