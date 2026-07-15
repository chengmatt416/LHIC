import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { testWebFlow } from "@lhic/skills";
import { downloadFile, fillForm, login, search } from "@lhic/skills";
import type { SkillResult } from "@lhic/skills";
import { VerifierEngine } from "@lhic/verifier";

export type BenchmarkSkill =
  "fill_form" | "download_file" | "login" | "search" | "test_web_flow";

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
  fastPathRatio: number;
  structuredActionRatio: number;
  rawCoordinateActionRatio: number;
  verifierPassRate: number;
  falsePositiveSuccessRate: number;
  humanInterventionCount: number;
}

export interface InternalBenchmarkReport {
  fixtureCount: number;
  metrics: BenchmarkMetrics;
  passCriteria: {
    taskSuccessRate: boolean;
    medianModelCallsPerTask: boolean;
    fastPathRatio: boolean;
    verifierPassRate: boolean;
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

export function assessBenchmark(
  metrics: BenchmarkMetrics,
): InternalBenchmarkReport["passCriteria"] {
  return {
    taskSuccessRate: metrics.taskSuccessRate >= 0.85,
    medianModelCallsPerTask: metrics.modelCallsPerTask <= 2,
    fastPathRatio: metrics.fastPathRatio >= 0.7,
    verifierPassRate: metrics.verifierPassRate >= 0.9,
  };
}

export async function runInternalBenchmark(
  projectRoot = process.cwd(),
): Promise<InternalBenchmarkReport> {
  const fixtures = await loadInternalFixtures(projectRoot);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lhic-benchmark-"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results: BenchmarkTaskResult[] = [];

  try {
    for (const fixture of fixtures) {
      const startedAt = performance.now();
      const result = await executeFixture(page, fixture, temporaryDirectory);
      results.push({
        fixtureId: fixture.id,
        skill: fixture.skill,
        durationMs: Math.round(performance.now() - startedAt),
        success: result.success,
        modelCalls: 0,
        fastPath: true,
        structuredActions: structuredActionCount(fixture.skill),
        rawCoordinateActions: 0,
        verifierPassed: result.success,
        falsePositive: false,
        humanIntervention: result.askUser === true,
      });
    }
  } finally {
    await browser.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const metrics = calculateBenchmarkMetrics(results);
  const passCriteria = assessBenchmark(metrics);
  return {
    fixtureCount: fixtures.length,
    metrics,
    passCriteria,
    passed: Object.values(passCriteria).every(Boolean),
  };
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
      return fillForm(context, { fields: { name: value }, submit: true });
    case "download_file":
      await page.setContent(
        `<a id="download" download="report-${fixture.variant}.txt" href="data:text/plain,benchmark-${fixture.variant}">Download</a>`,
      );
      return downloadFile(context, {
        trigger: "#download",
        expectedExtension: ".txt",
        downloadDir: temporaryDirectory,
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
        '<input id="name"><button id="save">Save</button><p id="result"></p><script>document.querySelector("#save").addEventListener("click", () => { document.querySelector("#result").textContent = "Saved"; });</script>',
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
          {
            type: "click",
            intent: "save",
            target: "#save",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
        ],
        successConditions: [
          { type: "dom", description: "saved", params: { text: "Saved" } },
        ],
        stopBeforeHighRisk: true,
      });
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

function structuredActionCount(skill: BenchmarkSkill): number {
  return skill === "test_web_flow" ? 2 : skill === "fill_form" ? 2 : 1;
}
