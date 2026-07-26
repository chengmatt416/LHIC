import { describe, expect, it } from "vitest";

import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { FastPathRouter } from "./fast-path-router.js";
import { HumanIntentLearnLoop } from "./human-intent-learnloop.js";
import { PredictionFirstHumanIntentController } from "./prediction-first-human-intent-controller.js";

const searchIntent: UserIntent = {
  goal: "Search for a project",
  constraints: { query: "release" },
  riskLevel: "low",
  requiresConfirmation: false,
  missingInformation: [],
};

const searchState: NormalizedUIState = {
  surface: "browser",
  objects: [
    {
      id: "search",
      role: "searchbox",
      label: "Search projects",
      source: "dom",
    },
  ],
  signals: {},
  capturedAt: "2026-07-26T00:00:00.000Z",
};

const ambiguousState: NormalizedUIState = {
  ...searchState,
  objects: [
    { id: "email", role: "textbox", label: "Email", source: "dom" },
    {
      id: "password",
      role: "textbox",
      label: "Password",
      source: "dom",
    },
    ...searchState.objects,
  ],
};

describe("PredictionFirstHumanIntentController", () => {
  it("routes a clear base prediction through the existing FastPathRouter", () => {
    const controller = new PredictionFirstHumanIntentController(
      new FastPathRouter(),
    );
    const result = controller.route("clear-search", searchIntent, searchState);

    expect(result.humanIntent.basePrediction.predictedIntent).toBe("search");
    expect(result.humanIntent.appliedRuleIds).toEqual([]);
    expect(result.route.decision.path).toBe("fast");
  });

  it("preserves the router and risk policy as the final authority", () => {
    const controller = new PredictionFirstHumanIntentController(
      new FastPathRouter(),
    );
    const result = controller.route(
      "risky-search",
      { ...searchIntent, riskLevel: "high", requiresConfirmation: true },
      searchState,
    );

    expect(result.route.decision.path).toBe("ask_user");
  });

  it("turns a detected LearnLoop transition into confirmation before routing", () => {
    const loop = new HumanIntentLearnLoop();
    const controller = new PredictionFirstHumanIntentController(
      new FastPathRouter(),
      loop,
    );
    controller.route("drift-route", searchIntent, ambiguousState);
    for (const taskId of ["route-1", "route-2", "route-3"]) {
      loop.recordCorrection({
        provenance: {
          taskId,
          uiFingerprint: hashState({ taskId, kind: "training-ui" }),
          traceSha256: hashState({ taskId, kind: "training-trace" }),
          verifierVersion: "router-test-v1",
          split: "training",
        },
        intent: searchIntent,
        uiState: ambiguousState,
        predictedStage: "login",
        correctedStage: "search",
        confirmedByUser: true,
        verification: { success: true, evidence: ["verified"] },
      });
    }
    loop.recordCorrection({
      provenance: {
        taskId: "route-validation",
        uiFingerprint: hashState("route-validation-ui"),
        traceSha256: hashState("route-validation-trace"),
        verifierVersion: "router-test-v1",
        split: "validation",
      },
      intent: searchIntent,
      uiState: ambiguousState,
      predictedStage: "login",
      correctedStage: "search",
      confirmedByUser: true,
      verification: { success: true, evidence: ["verified"] },
    });

    const result = controller.route(
      "drift-route",
      searchIntent,
      ambiguousState,
    );
    expect(result.humanIntent.drift.detected).toBe(true);
    expect(result.route.decision.path).toBe("ask_user");
  });
});
