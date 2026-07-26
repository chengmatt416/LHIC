import { describe, expect, it } from "vitest";

import { runLearnLoopBenchmark } from "./learnloop-benchmark.js";

describe("LearnLoop benchmark", () => {
  it("reports a deterministic prediction-first accuracy and drift study", () => {
    const report = runLearnLoopBenchmark();

    expect(report).toMatchObject({
      schemaVersion: "lhic-learnloop-benchmark-v2",
      methodology: {
        trainingCorrections: 6,
        validationCorrections: 2,
        holdoutTasks: 12,
        driftScenarios: 8,
        synthetic: true,
        modelCalls: 0,
        networkCalls: 0,
      },
    });
    expect(report.metrics.learnedTop1Accuracy).toBeGreaterThan(
      report.metrics.baseTop1Accuracy,
    );
    expect(report.metrics.riskyMisexecutionRate).toBe(0);
    expect(report.metrics.correctionRetentionRate).toBe(1);
    expect(report.metrics.driftTruePositive).toBeGreaterThanOrEqual(3);
    expect(report.metrics.driftFalsePositive).toBe(0);
    expect(report.metrics.driftF1).toBeGreaterThanOrEqual(0.8);
    expect(report.passed).toBe(true);
  });
});
