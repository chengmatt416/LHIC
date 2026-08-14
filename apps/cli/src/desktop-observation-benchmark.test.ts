import { describe, expect, it } from "vitest";

import {
  observationFixtures,
  scoreObservationFixtures,
} from "./desktop-observation-benchmark.js";

describe("desktop observation benchmark", () => {
  it("scores the deterministic fixture set", () => {
    const metrics = scoreObservationFixtures(observationFixtures);
    // Deterministic scores for the fixed fixture set.
    expect(metrics.elementRecall).toBe(1); // Every target exists in its tree.
    expect(metrics.targetUniquenessRate).toBe(7 / 8); // duplicate-label is ambiguous.
    expect(metrics.ambiguousCount).toBe(1);
    expect(metrics.fallbackRate).toBe(1 / 8); // Only the duplicate needs vision/native.
    expect(metrics.falseMatchRate).toBe(0);
    expect(metrics.staleTargetRate).toBe(1 / 8);
    expect(metrics.coordinateErrorPx).toBe(0);
  });

  it("records label accuracy and fallback evidence per fixture", () => {
    const duplicate = observationFixtures.find(
      (fixture) => fixture.kind === "duplicate-label",
    );
    expect(duplicate?.expectUnique).toBe(false);
    const stale = observationFixtures.find(
      (fixture) => fixture.kind === "stale-tree",
    );
    expect(stale?.expectUnique).toBe(true);
    expect(observationFixtures).toHaveLength(8);
  });
});
