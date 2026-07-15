import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessBenchmark,
  calculateBenchmarkMetrics,
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
    expect(fixtures).toHaveLength(50);
    for (const skill of [
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
      fastPathRatio: true,
      verifierPassRate: true,
    });
  });
});
