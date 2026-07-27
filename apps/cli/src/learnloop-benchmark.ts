import {
  HumanIntentLearnLoop,
  predictIntent,
  type CorrectionEvidenceSplit,
  type HumanIntentDecision,
  type VerifiedIntentCorrection,
} from "@lhic/controller";
import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import { hashState } from "@lhic/trace";

export interface LearnLoopBenchmarkMetrics {
  taskCount: number;
  baseTop1Accuracy: number;
  learnedTop1Accuracy: number;
  accuracyGain: number;
  fastPathCoverage: number;
  riskyMisexecutionRate: number;
  correctionRetentionRate: number;
  driftTruePositive: number;
  driftFalsePositive: number;
  driftFalseNegative: number;
  driftPrecision: number;
  driftRecall: number;
  driftF1: number;
  decisionLatencyP50Ms: number;
  decisionLatencyP95Ms: number;
}

export interface LearnLoopBenchmarkReport {
  schemaVersion: "lhic-learnloop-benchmark-v2";
  methodology: {
    trainingCorrections: number;
    validationCorrections: number;
    holdoutTasks: number;
    driftScenarios: number;
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

interface DriftCounts {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  scenarioCount: number;
}

export function runLearnLoopBenchmark(): LearnLoopBenchmarkReport {
  const loop = new HumanIntentLearnLoop();
  trainAndValidateSearchRule(loop, "primary-search");
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
    ambiguousWorkspaceState(21),
  );
  trainAndValidateFormRule(loop, "unrelated-form");
  const retainedAfter = loop.decide(
    "retention-after",
    searchIntent("retention-after"),
    ambiguousWorkspaceState(22),
  );
  const correctionRetentionRate =
    retainedBefore.prediction.predictedIntent === "search" &&
    retainedAfter.prediction.predictedIntent === "search"
      ? 1
      : 0;

  const drift = evaluateDriftScenarios();
  const driftPrecision = ratio(
    drift.truePositive,
    drift.truePositive + drift.falsePositive,
  );
  const driftRecall = ratio(
    drift.truePositive,
    drift.truePositive + drift.falseNegative,
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
    driftTruePositive: drift.truePositive,
    driftFalsePositive: drift.falsePositive,
    driftFalseNegative: drift.falseNegative,
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
    decisionLatencyP95: metrics.decisionLatencyP95Ms <= 20,
  };
  return {
    schemaVersion: "lhic-learnloop-benchmark-v2",
    methodology: {
      trainingCorrections: 6,
      validationCorrections: 2,
      holdoutTasks: holdout.length,
      driftScenarios: drift.scenarioCount,
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
    ...[5, 6, 7, 8, 9, 10].map((variant) => ({
      id: `ambiguous-search-${variant}`,
      intent: searchIntent(`holdout-${variant}`),
      state: ambiguousWorkspaceState(variant),
      expectedStage: "search" as const,
    })),
    ...[1, 2, 3].map((variant) => ({
      id: `login-${variant}`,
      intent: loginIntent(),
      state: loginState(variant),
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
    {
      id: "form-1",
      intent: formIntent(),
      state: formState(11),
      expectedStage: "form_filling",
    },
  ];
}

function evaluateDriftScenarios(): DriftCounts {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let scenarioCount = 0;

  const changedLoop = new HumanIntentLearnLoop();
  const changedIntent = searchIntent("drift-change");
  const changedState = ambiguousWorkspaceState(31);
  changedLoop.decide("changed-session", changedIntent, changedState);
  trainAndValidateSearchRule(changedLoop, "changed-rule");
  const changed = changedLoop.decide(
    "changed-session",
    changedIntent,
    changedState,
  );
  scenarioCount += 1;
  if (changed.drift.detected) truePositive += 1;
  else falseNegative += 1;

  const conflictLoop = new HumanIntentLearnLoop();
  trainAndValidateSearchRule(conflictLoop, "conflict-search");
  conflictLoop.recordCorrection({
    ...correction(
      "conflict-download",
      "training",
      searchIntent("conflict"),
      ambiguousWorkspaceState(32),
      "login",
      "download",
    ),
  });
  const conflict = conflictLoop.decide(
    "conflict-session",
    searchIntent("conflict"),
    ambiguousWorkspaceState(33),
  );
  scenarioCount += 1;
  if (conflict.drift.detected) truePositive += 1;
  else falseNegative += 1;

  const oscillationLoop = new HumanIntentLearnLoop();
  const oscillationIntent = searchIntent("oscillation");
  oscillationLoop.decide(
    "oscillation-session",
    oscillationIntent,
    loginState(41),
  );
  oscillationLoop.decide(
    "oscillation-session",
    oscillationIntent,
    searchOnlyState(42),
  );
  const oscillating = oscillationLoop.decide(
    "oscillation-session",
    oscillationIntent,
    loginState(43),
  );
  scenarioCount += 1;
  if (oscillating.drift.detected) truePositive += 1;
  else falseNegative += 1;

  const stableLoop = new HumanIntentLearnLoop();
  trainAndValidateSearchRule(stableLoop, "stable-rule");
  for (const variant of [51, 52, 53, 54, 55]) {
    const stable = stableLoop.decide(
      `stable-${variant}`,
      searchIntent(`stable-${variant}`),
      ambiguousWorkspaceState(variant),
    );
    scenarioCount += 1;
    if (stable.drift.detected) falsePositive += 1;
  }

  return { truePositive, falsePositive, falseNegative, scenarioCount };
}

function trainAndValidateSearchRule(
  loop: HumanIntentLearnLoop,
  prefix: string,
): void {
  for (const variant of [1, 2, 3]) {
    loop.recordCorrection(
      correction(
        `${prefix}-training-${variant}`,
        "training",
        searchIntent(`${prefix}-${variant}`),
        ambiguousWorkspaceState(variant),
        "login",
        "search",
      ),
    );
  }
  loop.recordCorrection(
    correction(
      `${prefix}-validation`,
      "validation",
      searchIntent(`${prefix}-validation`),
      ambiguousWorkspaceState(4),
      "login",
      "search",
    ),
  );
}

function trainAndValidateFormRule(
  loop: HumanIntentLearnLoop,
  prefix: string,
): void {
  for (const variant of [1, 2, 3]) {
    loop.recordCorrection(
      correction(
        `${prefix}-training-${variant}`,
        "training",
        formIntent(),
        ambiguousFormState(variant),
        "login",
        "form_filling",
      ),
    );
  }
  loop.recordCorrection(
    correction(
      `${prefix}-validation`,
      "validation",
      formIntent(),
      ambiguousFormState(4),
      "login",
      "form_filling",
    ),
  );
}

function correction(
  taskId: string,
  split: CorrectionEvidenceSplit,
  intent: UserIntent,
  state: NormalizedUIState,
  predictedStage: VerifiedIntentCorrection["predictedStage"],
  correctedStage: VerifiedIntentCorrection["correctedStage"],
): VerifiedIntentCorrection {
  return {
    provenance: {
      taskId,
      uiFingerprint: hashState({ taskId, split, state }),
      traceSha256: hashState({ taskId, split, result: "verified" }),
      verifierVersion: "benchmark-verifier-v2",
      split,
    },
    intent,
    uiState: state,
    predictedStage,
    correctedStage,
    confirmedByUser: true,
    verification: {
      success: true,
      evidence: [`Verified correction for ${taskId}.`],
    },
  };
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

function formIntent(): UserIntent {
  return {
    goal: "Fill and save the profile form",
    constraints: { profile: true },
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
}

function ambiguousWorkspaceState(variant: number): NormalizedUIState {
  const extras =
    variant % 2 === 0
      ? [
          {
            id: `help-${variant}`,
            role: "link",
            label: "Help",
            source: "dom" as const,
          },
        ]
      : [];
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
        label: variant % 3 === 0 ? "Find projects" : "Search projects",
        source: "dom",
      },
      ...extras,
    ],
    signals: { layoutVariant: variant },
    capturedAt: "2026-07-26T00:00:00.000Z",
  };
}

function ambiguousFormState(variant: number): NormalizedUIState {
  return {
    surface: "browser",
    objects: [
      { id: "email", role: "textbox", label: "Email", source: "dom" },
      {
        id: "password",
        role: "textbox",
        label: "Password",
        source: "dom",
      },
      {
        id: `required-${variant}`,
        role: "textbox",
        label: "Required display name *",
        source: "dom",
      },
      {
        id: `save-${variant}`,
        role: "button",
        label: "Save",
        enabled: false,
        source: "dom",
      },
    ],
    signals: { layoutVariant: variant },
    capturedAt: "2026-07-26T00:00:00.000Z",
  };
}

function loginState(variant: number): NormalizedUIState {
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

function searchOnlyState(variant: number): NormalizedUIState {
  return {
    surface: "browser",
    objects: [
      {
        id: `search-${variant}`,
        role: "searchbox",
        label: "Search projects",
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

function formState(variant: number): NormalizedUIState {
  return {
    surface: "browser",
    objects: [
      {
        id: `required-${variant}`,
        role: "textbox",
        label: "Required name *",
        source: "dom",
      },
      {
        id: `save-${variant}`,
        role: "button",
        label: "Save",
        enabled: false,
        source: "dom",
      },
    ],
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
