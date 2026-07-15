import { describe, expect, it } from "vitest";

import { runSelectorResilienceSimulation } from "./selector-resilience-simulation.js";

describe("runSelectorResilienceSimulation", () => {
  it("measures semantic targeting against a clearly-scoped static-selector ablation", async () => {
    const report = await runSelectorResilienceSimulation({
      taskCount: 25,
      seed: 42,
    });

    expect(report).toMatchObject({
      simulation: "selector-resilience-ablation",
      taskCount: 25,
      directSemantic: { taskSuccessRate: 1 },
      staticSelectorBaseline: { taskSuccessRate: 0.2 },
      successRateDelta: 0.8,
      observedLargeControlledAdvantage: true,
      externalSubmissionEligible: false,
    });
  });

  it("rejects invalid simulation sizes", async () => {
    await expect(
      runSelectorResilienceSimulation({ taskCount: 4 }),
    ).rejects.toThrow("taskCount");
  });
});
