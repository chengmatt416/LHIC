import { describe, expect, it } from "vitest";

import { runLearnLoopBenchmark } from "./learnloop-benchmark.js";

describe("LearnLoop benchmark", () => {
  it("reports a deterministic prediction-first accuracy and drift study", () => {
    const report = runLearnLoopBenchmark();

    expect(report).toMatchObject({
      schemaVersion: "lhic-learnloop-benchmark-v1",
      methodology: {
        trainingCorrections: 3,
        holdoutTasks: 10,
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
    expect(report.metrics.driftF1).toBe(1);
    expect(report.passed).toBe(true);
  });
});
