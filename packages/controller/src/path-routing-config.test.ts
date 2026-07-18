import { describe, expect, it } from "vitest";

import { FastPathRouter } from "./fast-path-router.js";
import { readPathRoutingConfig } from "./path-routing-config.js";
import { TaskBudgetTracker } from "./task-budget.js";

describe("path routing configuration", () => {
  it("defaults to legacy fast_only and validates opt-in modes", () => {
    expect(readPathRoutingConfig({})).toEqual({
      mode: "legacy",
      defaultProfile: "fast_only",
    });
    expect(
      readPathRoutingConfig({
        LHIC_PATH_ROUTING_MODE: "shadow",
        LHIC_EXECUTION_PROFILE: "balanced",
      }),
    ).toEqual({ mode: "shadow", defaultProfile: "balanced" });
    expect(() =>
      readPathRoutingConfig({ LHIC_EXECUTION_PROFILE: "unbounded" }),
    ).toThrow("LHIC_EXECUTION_PROFILE");
  });

  it("keeps legacy execution untouched and marks shadow decisions", () => {
    const router = new FastPathRouter();
    const input = {
      stage: "plan" as const,
      intent: {
        goal: "Search",
        constraints: {},
        riskLevel: "low" as const,
        requiresConfirmation: false,
        missingInformation: [],
      },
      prediction: {
        predictedIntent: "search" as const,
        skillName: "search",
        confidence: 0.9,
        evidence: [],
      },
      hasLocalPlan: true,
      budget: new TaskBudgetTracker("fast_only"),
    };

    expect(
      router.routeConfiguredStage(input, {
        mode: "legacy",
        defaultProfile: "fast_only",
      }),
    ).toBeUndefined();
    expect(
      router.routeConfiguredStage(
        { ...input, budget: new TaskBudgetTracker("fast_only") },
        { mode: "shadow", defaultProfile: "fast_only" },
      ),
    ).toMatchObject({ path: "local_fast", shadow: true });
  });
});
