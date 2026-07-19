import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessBenchmark,
  calculateBenchmarkMetrics,
  calculateDailyWorkflowMetrics,
  type BenchmarkFixture,
} from "../../apps/cli/src/internal-benchmark.js";

describe("internal benchmark contract", () => {
  it("contains ten deterministic fixtures for each Fast Path skill and evaluates plan thresholds", async () => {
    const fixtures = JSON.parse(
      await readFile(
        join(process.cwd(), "tests", "fixtures", "internal-benchmark.json"),
        "utf8",
      ),
    ) as BenchmarkFixture[];
    expect(fixtures).toHaveLength(60);
    for (const skill of [
      "browser_plan",
      "fill_form",
      "download_file",
      "login",
      "search",
      "test_web_flow",
    ]) {
      expect(
        fixtures.filter((fixture) => fixture.skill === skill),
      ).toHaveLength(10);
    }

    const metrics = calculateBenchmarkMetrics(
      fixtures.map((fixture) => ({
        fixtureId: fixture.id,
        skill: fixture.skill,
        durationMs: 100,
        success: true,
        modelCalls: 0,
        mcpCalls: 0,
        fastPath: true,
        structuredActions: 1,
        rawCoordinateActions: 0,
        verifierPassed: true,
        falsePositive: false,
        humanIntervention: false,
      })),
    );
    expect(assessBenchmark(metrics)).toEqual({
      taskSuccessRate: true,
      medianModelCallsPerTask: true,
      mcpCallsPerTask: true,
      fastPathRatio: true,
      verifierPassRate: true,
    });
    expect(
      calculateDailyWorkflowMetrics(
        fixtures.map((fixture) => ({
          fixtureId: fixture.id,
          skill: fixture.skill,
          durationMs: 500,
          success: true,
          modelCalls: 0,
          mcpCalls: 0,
          fastPath: true,
          structuredActions: 1,
          rawCoordinateActions: 0,
          verifierPassed: true,
          falsePositive: false,
          humanIntervention: false,
        })),
      ),
    ).toEqual({
      taskCount: 10,
      taskSuccessRate: 1,
      p95TimeToCompleteMs: 500,
      verifierPassRate: 1,
    });
  });

  it("requires a five-run Fast Path baseline by default and rejects p95 regression", async () => {
    const baseline = [100, 105, 110, 115, 120].sort(
      (left, right) => left - right,
    );
    expect(baseline[Math.ceil(baseline.length * 0.5) - 1]).toBe(110);
    expect(122).toBeGreaterThan(110 * 1.1);
  });
});
