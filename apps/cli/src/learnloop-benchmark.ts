import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import { predictIntent } from "@lhic/controller";
import {
  HumanIntentLearnLoop,
  type HumanIntentDecision,
} from "@lhic/controller";

export interface LearnLoopBenchmarkMetrics {
  taskCount: number;
  baseTop1Accuracy: number;
  learnedTop1Accuracy: number;
  accuracyGain: number;
  fastPathCoverage: number;
  riskyMisexecutionRate: number;
  correctionRetentionRate: number;
  driftPrecision: number;
  driftRecall: number;
  driftF1: number;
  decisionLatencyP50Ms: number;
  decisionLatencyP95Ms: number;
}

export interface LearnLoopBenchmarkReport {
  schemaVersion: "lhic-learnloop-benchmark-v1";
  methodology: {
    trainingCorrections: number;
    holdoutTasks: number;
    synthetic: true;
    modelCalls: 0;
    networkCalls: 0;
  };
  metrics: LearnLoopBenchmarkMetrics;
  passCriteria: {
    learnedAccuracy: boolean;
    accuracyGain: boolean;
    riskyMisexecutionRate: boolean;
    correctionRetention: boolean;
    driftF1: boolean;
    decisionLatencyP95: boolean;
  };
  passed: boolean;
}

interface BenchmarkCase {
  id: string;
  intent: UserIntent;
  state: NormalizedUIState;
  expectedStage: ReturnType<typeof predictIntent>["predictedIntent"];
}

export function runLearnLoopBenchmark(): LearnLoopBenchmarkReport {
  const loop = new HumanIntentLearnLoop({ minimumEvidence: 3 });
  const trainingIntent = searchIntent("training-query");
  const trainingState = ambiguousWorkspaceState("training");
  for (const taskId of ["training-1", "training-2", "training-3"]) {
    loop.recordCorrection({
      taskId,
      intent: trainingIntent,
      uiState: trainingState,
      predictedStage: "login",
      correctedStage: "search",
      confirmedByUser: true,
      verification: {
        success: true,
        evidence: [`Verifier confirmed corrected search for ${taskId}.`],
      },
    });
  }

  const holdout = benchmarkCases();
  let baseCorrect = 0;
  let learnedCorrect = 0;
  let fastPathCount = 0;
  let riskyMisexecutions = 0;
  const latencies: number[] = [];
  for (const item of holdout) {
    const base = predictIntent(item.intent, item.state);
    if (base.predictedIntent === item.expectedStage) baseCorrect += 1;
    const decision = loop.decide(`holdout-${item.id}`, item.intent, item.state);
    latencies.push(decision.decisionLatencyMs);
    if (decision.prediction.predictedIntent === item.expectedStage) {
      learnedCorrect += 1;
    }
    if (decision.admission === "execute_fast") fastPathCount += 1;
    if (
      decision.admission === "execute_fast" &&
      decision.prediction.predictedIntent !== item.expectedStage
    ) {
      riskyMisexecutions += 1;
    }
  }

  const retainedBefore = loop.decide(
    "retention-before",
    searchIntent("retention-before"),
    ambiguousWorkspaceState("retention-before"),
  );
  trainUnrelatedFormCorrection(loop);
  const retainedAfter = loop.decide(
    "retention-after",
    searchIntent("retention-after"),
    ambiguousWorkspaceState("retention-after"),
  );
  const correctionRetentionRate =
    retainedBefore.prediction.predictedIntent === "search" &&
    retainedAfter.prediction.predictedIntent === "search"
      ? 1
      : 0;

  const driftOutcomes = evaluateDrift(loop);
  const driftPrecision = ratio(
    driftOutcomes.truePositive,
    driftOutcomes.truePositive + driftOutcomes.falsePositive,
  );
  const driftRecall = ratio(
    driftOutcomes.truePositive,
    driftOutcomes.truePositive + driftOutcomes.falseNegative,
  );
  const driftF1 =
    driftPrecision + driftRecall === 0
      ? 0
      : (2 * driftPrecision * driftRecall) / (driftPrecision + driftRecall);

  const metrics: LearnLoopBenchmarkMetrics = {
    taskCount: holdout.length,
    baseTop1Accuracy: ratio(baseCorrect, holdout.length),
    learnedTop1Accuracy: ratio(learnedCorrect, holdout.length),
    accuracyGain: ratio(learnedCorrect - baseCorrect, holdout.length),
    fastPathCoverage: ratio(fastPathCount, holdout.length),
    riskyMisexecutionRate: ratio(riskyMisexecutions, holdout.length),
    correctionRetentionRate,
    driftPrecision,
    driftRecall,
    driftF1,
    decisionLatencyP50Ms: percentile(latencies, 0.5),
    decisionLatencyP95Ms: percentile(latencies, 0.95),
  };
  const passCriteria = {
    learnedAccuracy: metrics.learnedTop1Accuracy >= 0.9,
    accuracyGain: metrics.accuracyGain >= 0.25,
    riskyMisexecutionRate: metrics.riskyMisexecutionRate === 0,
    correctionRetention: metrics.correctionRetentionRate === 1,
    driftF1: metrics.driftF1 >= 0.8,
    decisionLatencyP95: metrics.decisionLatencyP95Ms <= 5,
  };
  return {
    schemaVersion: "lhic-learnloop-benchmark-v1",
    methodology: {
      trainingCorrections: 3,
      holdoutTasks: holdout.length,
      synthetic: true,
      modelCalls: 0,
      networkCalls: 0,
    },
    metrics,
    passCriteria,
    passed: Object.values(passCriteria).every(Boolean),
  };
}

function benchmarkCases(): BenchmarkCase[] {
  return [
    ...[1, 2, 3, 4, 5].map((variant) => ({
      id: `ambiguous-search-${variant}`,
      intent: searchIntent(`holdout-${variant}`),
      state: ambiguousWorkspaceState(`holdout-${variant}`),
      expectedStage: "search" as const,
    })),
    ...[1, 2, 3].map((variant) => ({
      id: `login-${variant}`,
      intent: loginIntent(),
      state: loginState(`login-${variant}`),
      expectedStage: "login" as const,
    })),
    {
      id: "download-1",
      intent: downloadIntent(),
      state: downloadState(),
      expectedStage: "download",
    },
    {
      id: "test-flow-1",
      intent: testIntent(),
      state: testState(),
      expectedStage: "test_web_flow",
    },
  ];
}

function evaluateDrift(loop: HumanIntentLearnLoop): {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
} {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const stable = loop.decide(
    "stable-session",
    searchIntent("stable"),
    ambiguousWorkspaceState("stable"),
  );
  if (stable.drift.detected) falsePositive += 1;

  const fresh = new HumanIntentLearnLoop({ minimumEvidence: 1 });
  const intent = searchIntent("drift");
  const state = ambiguousWorkspaceState("drift");
  fresh.decide("positive-drift", intent, state);
  fresh.recordCorrection({
    taskId: "drift-training",
    intent,
    uiState: state,
    predictedStage: "login",
    correctedStage: "search",
    confirmedByUser: true,
    verification: { success: true, evidence: ["verified"] },
  });
  const changed = fresh.decide("positive-drift", intent, state);
  if (changed.drift.detected) truePositive += 1;
  else falseNegative += 1;
  return { truePositive, falsePositive, falseNegative };
}

function trainUnrelatedFormCorrection(loop: HumanIntentLearnLoop): void {
  const intent: UserIntent = {
    goal: "Fill and save the profile form",
    constraints: { profile: true },
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
  const state: NormalizedUIState = {
    surface: "browser",
    objects: [
      {
        id: "required-name",
        role: "textbox",
        label: "Required name *",
        source: "dom",
      },
      {
        id: "save",
        role: "button",
        label: "Save",
        enabled: false,
        source: "dom",
      },
    ],
    signals: {},
    capturedAt: "2026-07-26T00:10:00.000Z",
  };
  loop.recordCorrection({
    taskId: "unrelated-form-correction",
    intent,
    uiState: state,
    predictedStage: "unknown",
    correctedStage: "form_filling",
    confirmedByUser: true,
    verification: { success: true, evidence: ["form verified"] },
  });
}

function searchIntent(query: string): UserIntent {
  return {
    goal: "Search for a project",
    constraints: { query },
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function loginIntent(): UserIntent {
  return {
    goal: "Log in to the workspace",
    constraints: {},
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function downloadIntent(): UserIntent {
  return {
    goal: "Download the report",
    constraints: {},
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function testIntent(): UserIntent {
  return {
    goal: "Verify the current workflow",
    constraints: {},
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function ambiguousWorkspaceState(variant: string): NormalizedUIState {
  return {
    surface: "browser",
    url: `https://example.test/workspace/${variant}`,
    objects: [
      { id: "email", role: "textbox", label: "Email", source: "dom" },
      {
        id: "password",
        role: "textbox",
        label: "Password",
        source: "dom",
      },
      {
        id: "search",
        role: "searchbox",
        label: "Search projects",
        source: "dom",
      },
    ],
    signals: {},
    capturedAt: "2026-07-26T00:00:00.000Z",
  };
}

function loginState(variant: string): NormalizedUIState {
  return {
    surface: "browser",
    url: `https://example.test/login/${variant}`,
    objects: [
      { id: "email", role: "textbox", label: "Email", source: "dom" },
      {
        id: "password",
        role: "textbox",
        label: "Password",
        source: "dom",
      },
    ],
    signals: {},
    capturedAt: "2026-07-26T00:00:00.000Z",
  };
}

function downloadState(): NormalizedUIState {
  return {
    surface: "browser",
    objects: [
      {
        id: "download",
        role: "button",
        label: "Download report",
        source: "dom",
      },
    ],
    signals: {},
    capturedAt: "2026-07-26T00:00:00.000Z",
  };
}

function testState(): NormalizedUIState {
  return {
    surface: "browser",
    title: "Workflow",
    objects: [{ id: "main", role: "main", source: "dom" }],
    signals: {},
    capturedAt: "2026-07-26T00:00:00.000Z",
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

export function summarizeLearnLoopDecision(
  decision: HumanIntentDecision,
): Record<string, unknown> {
  return {
    admission: decision.admission,
    baseIntent: decision.basePrediction.predictedIntent,
    finalIntent: decision.prediction.predictedIntent,
    confidence: decision.prediction.confidence,
    driftScore: decision.drift.score,
    latencyMs: decision.decisionLatencyMs,
  };
}
