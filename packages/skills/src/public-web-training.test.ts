import { describe, expect, it } from "vitest";

import {
  buildPublicWebTrainingPlan,
  getPublicWebTrainingScenario,
  publicWebTrainingScenarioIds,
} from "./public-web-training.js";

describe("public web training scenarios", () => {
  it("ships only low-risk, directly executable public workflows", () => {
    expect(publicWebTrainingScenarioIds).toEqual([
      "wikipedia-search",
      "mdn-search",
      "github-issue-filter",
      "openstreetmap-place-search",
    ]);
    for (const scenarioId of publicWebTrainingScenarioIds) {
      const scenario = getPublicWebTrainingScenario(scenarioId);
      const plan = buildPublicWebTrainingPlan(scenarioId, "safe query");
      expect(scenario.allowedOrigin).toBe(new URL(scenario.entryUrl).origin);
      expect(plan.steps.length).toBeGreaterThan(1);
      expect(plan.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: expect.objectContaining({ riskLevel: "low" }),
          }),
        ]),
      );
      expect(plan.steps.every((step) => step.action.type !== "custom")).toBe(
        true,
      );
    }
  });

  it("rejects unknown scenarios and empty or oversized user input", () => {
    expect(() => getPublicWebTrainingScenario("unknown")).toThrow(
      "Unknown public-web training scenario",
    );
    expect(() => buildPublicWebTrainingPlan("mdn-search", " ")).toThrow(
      "non-empty query",
    );
    expect(() =>
      buildPublicWebTrainingPlan("mdn-search", "x".repeat(257)),
    ).toThrow("256 characters");
  });

  it("uses a query-parameter verifier for GitHub issue filtering", () => {
    const plan = buildPublicWebTrainingPlan(
      "github-issue-filter",
      "is:issue state:open label:bug",
    );
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.action).toMatchObject({
      target: 'input[placeholder="Search Issues"]',
    });
    expect(plan.steps[1]?.verification).toMatchObject({
      type: "url",
      params: { hasQueryParam: "q" },
    });
  });

  it("uses a visible control and URL verifier for place search", () => {
    const plan = buildPublicWebTrainingPlan(
      "openstreetmap-place-search",
      "Taipei Main Station",
    );
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]?.action).toMatchObject({
      target: "input#query:visible",
    });
    expect(plan.steps[1]?.verification).toMatchObject({
      type: "url",
      params: { hasQueryParam: "query" },
    });
  });
});
