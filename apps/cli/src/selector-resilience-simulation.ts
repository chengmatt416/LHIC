import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { fillForm } from "@lhic/skills";
import { VerifierEngine } from "@lhic/verifier";

const layouts = [
  "explicit-label",
  "aria-label",
  "name-attribute",
  "placeholder",
  "wrapped-label",
] as const;

type Layout = (typeof layouts)[number];

export interface SelectorResilienceSimulationOptions {
  taskCount?: number;
  seed?: number;
}

export interface SimulationTreatmentMetrics {
  successfulTasks: number;
  taskSuccessRate: number;
  medianDurationMs: number;
  p95DurationMs: number;
}

export interface SelectorResilienceSimulationReport {
  simulation: "selector-resilience-ablation";
  seed: number;
  taskCount: number;
  directSemantic: SimulationTreatmentMetrics;
  staticSelectorBaseline: SimulationTreatmentMetrics;
  successRateDelta: number;
  observedLargeControlledAdvantage: boolean;
  externalSubmissionEligible: false;
  conclusion: string;
}

interface TrialOutcome {
  success: boolean;
  durationMs: number;
}

export async function runSelectorResilienceSimulation(
  options: SelectorResilienceSimulationOptions = {},
): Promise<SelectorResilienceSimulationReport> {
  const taskCount = normalizeTaskCount(options.taskCount ?? 100);
  const seed = normalizeSeed(options.seed ?? 20_260_715);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "lhic-simulation-"));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const directOutcomes: TrialOutcome[] = [];
  const baselineOutcomes: TrialOutcome[] = [];

  try {
    for (let index = 0; index < taskCount; index += 1) {
      const task = createTask(index, seed);
      directOutcomes.push(
        await runDirectSemanticTreatment(page, task, temporaryDirectory),
      );
      baselineOutcomes.push(await runStaticSelectorBaseline(page, task));
    }
  } finally {
    await browser.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  const directSemantic = summarizeTreatment(directOutcomes);
  const staticSelectorBaseline = summarizeTreatment(baselineOutcomes);
  const successRateDelta =
    directSemantic.taskSuccessRate - staticSelectorBaseline.taskSuccessRate;
  const observedLargeControlledAdvantage =
    directSemantic.taskSuccessRate >= 0.95 && successRateDelta >= 0.5;

  return {
    simulation: "selector-resilience-ablation",
    seed,
    taskCount,
    directSemantic,
    staticSelectorBaseline,
    successRateDelta,
    observedLargeControlledAdvantage,
    externalSubmissionEligible: false,
    conclusion: observedLargeControlledAdvantage
      ? "The direct semantic treatment has a large advantage over the explicitly limited static-selector ablation. This local simulation is not a market comparison and cannot justify benchmark submission or a SOTA claim."
      : "No large controlled advantage was observed. This local simulation cannot justify benchmark submission or a SOTA claim.",
  };
}

async function runDirectSemanticTreatment(
  page: Page,
  task: SimulationTask,
  temporaryDirectory: string,
): Promise<TrialOutcome> {
  await page.setContent(renderTask(task));
  const startedAt = performance.now();
  const verifier = new VerifierEngine({ page });
  const skillResult = await fillForm(
    {
      page,
      verifier,
      taskId: `direct-${task.id}`,
      traceFilePath: join(temporaryDirectory, `direct-${task.id}.jsonl`),
    },
    { fields: { "Full name": task.value }, submit: true },
  );
  const verification = await verifier.verify({
    type: "dom",
    description: "The primary form control was saved.",
    params: { text: `Saved:${task.value}` },
  });

  return {
    success: skillResult.success && verification.success,
    durationMs: Math.round(performance.now() - startedAt),
  };
}

async function runStaticSelectorBaseline(
  page: Page,
  task: SimulationTask,
): Promise<TrialOutcome> {
  await page.setContent(renderTask(task));
  const startedAt = performance.now();
  const staticField = page.locator('form input[name="full_name"]').first();
  if ((await staticField.count()) === 0) {
    return {
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }

  try {
    await staticField.fill(task.value);
    await page.locator('form button[type="submit"]').first().click();
    const verifier = new VerifierEngine({ page });
    const verification = await verifier.verify({
      type: "dom",
      description: "The primary form control was saved.",
      params: { text: `Saved:${task.value}` },
    });
    return {
      success: verification.success,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch {
    return {
      success: false,
      durationMs: Math.round(performance.now() - startedAt),
    };
  }
}

interface SimulationTask {
  id: string;
  layout: Layout;
  value: string;
}

function createTask(index: number, seed: number): SimulationTask {
  const layoutOffset = positiveModulo(seed, layouts.length);
  const layout = layouts[(index + layoutOffset) % layouts.length];
  if (!layout) {
    throw new Error("Simulation layout could not be resolved.");
  }
  return {
    id: `${seed}-${index + 1}`,
    layout,
    value: `sample-${seed}-${index + 1}`,
  };
}

function renderTask(task: SimulationTask): string {
  const inputId = `full-name-${task.id}`;
  const primaryControl = renderPrimaryControl(task.layout, inputId);
  return `
    <form>
      ${primaryControl}
      <button type="submit">Save profile</button>
    </form>
    <p id="result"></p>
    <script>
      document.querySelector("form").addEventListener("submit", (event) => {
        event.preventDefault();
        document.querySelector("#result").textContent = "Saved:" + document.querySelector("[data-primary]").value;
      });
    </script>
  `;
}

function renderPrimaryControl(layout: Layout, inputId: string): string {
  switch (layout) {
    case "explicit-label":
      return `<label for="${inputId}">Full name</label><input id="${inputId}" name="profile_name" data-primary>`;
    case "aria-label":
      return `<input id="${inputId}" aria-label="Full name" name="profile_name" data-primary>`;
    case "name-attribute":
      return `<input id="${inputId}" name="full_name" data-primary>`;
    case "placeholder":
      return `<input id="${inputId}" name="profile_name" placeholder="Full name" data-primary>`;
    case "wrapped-label":
      return `<label>Full name <input id="${inputId}" name="profile_name" data-primary></label>`;
  }
}

function summarizeTreatment(
  outcomes: TrialOutcome[],
): SimulationTreatmentMetrics {
  const durations = outcomes
    .map((outcome) => outcome.durationMs)
    .sort((left, right) => left - right);
  const successfulTasks = outcomes.filter((outcome) => outcome.success).length;
  return {
    successfulTasks,
    taskSuccessRate: successfulTasks / outcomes.length,
    medianDurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
  };
}

function percentile(sorted: number[], quantile: number): number {
  return (
    sorted[
      Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
    ] ?? 0
  );
}

function normalizeTaskCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 5 || value > 500) {
    throw new Error("taskCount must be an integer between 5 and 500.");
  }
  return value;
}

function normalizeSeed(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error("seed must be a safe integer.");
  }
  return value;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
