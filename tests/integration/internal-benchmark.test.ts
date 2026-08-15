import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessBenchmark,
  assessP95Stability,
  calculateBenchmarkMetrics,
  calculateDailyWorkflowMetrics,
  validateInternalFixtures,
} from "../../apps/cli/src/internal-benchmark.js";

describe("internal benchmark contract", () => {
  it("contains ten deterministic fixtures for each Fast Path skill and evaluates plan thresholds", async () => {
    const fixtures = validateInternalFixtures(
      JSON.parse(
        await readFile(
          join(process.cwd(), "tests", "fixtures", "internal-benchmark.json"),
          "utf8",
        ),
      ) as unknown,
    );
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

  it("rejects unstable p95 runs through the production assessment", () => {
    expect(assessP95Stability([100, 105, 110, 115, 122])).toEqual({
      baselineP95Ms: 110,
      passed: false,
    });
    expect(assessP95Stability([100, 105, 110, 115, 120])).toEqual({
      baselineP95Ms: 110,
      passed: true,
    });
  });

  it("rejects duplicate fixture IDs before running the browser", () => {
    expect(() =>
      validateInternalFixtures([
        { id: "duplicate", skill: "search", variant: 1 },
        { id: "duplicate", skill: "login", variant: 2 },
      ]),
    ).toThrow("Duplicate internal benchmark fixture ID");
  });
});
