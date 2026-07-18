import { describe, expect, it } from "vitest";

import { FastPathRouter } from "./fast-path-router.js";
import { TaskBudgetTracker } from "./task-budget.js";

const intent = {
  goal: "Search for notebooks",
  constraints: { operation: "search" },
  riskLevel: "low" as const,
  requiresConfirmation: false,
  missingInformation: [],
};

const confidentPrediction = {
  predictedIntent: "search" as const,
  skillName: "search",
  confidence: 0.9,
  evidence: ["Search field is available."],
};

const uncertainPrediction = {
  predictedIntent: "unknown" as const,
  confidence: 0.3,
  evidence: ["No local skill matched."],
};

describe("stage-aware multi-path routing", () => {
  it("keeps a clear low-risk skill on the local Fast Path", () => {
    const route = new FastPathRouter().routeStage({
      stage: "plan",
      profile: "fast_only",
      intent,
      prediction: confidentPrediction,
      hasLocalPlan: true,
      budget: new TaskBudgetTracker("fast_only"),
    });

    expect(route).toMatchObject({
      path: "local_fast",
      profile: "fast_only",
      remainingBudget: { maxSlowPathCalls: 0 },
    });
  });

  it("never invokes a provider for a local route", async () => {
    let invoked = false;
    const router = new FastPathRouter({
      reason: async () => {
        invoked = true;
        return { decision: "blocked", message: "must not run" };
      },
    });
    const budget = new TaskBudgetTracker("fast_only");
    const route = router.routeStage({
      stage: "plan",
      profile: "fast_only",
      intent,
      prediction: confidentPrediction,
      hasLocalPlan: true,
      budget,
    });

    await expect(
      router.invokeRoutedSlowPath(
        route,
        {
          taskId: "fast-path",
          userIntent: intent,
          uiState: {
            surface: "browser",
            objects: [],
            signals: {},
            capturedAt: "2026-07-17T00:00:00.000Z",
          },
          recentTrace: [],
          reason: "low_confidence",
        },
        budget,
      ),
    ).resolves.toBeUndefined();
    expect(invoked).toBe(false);
  });

  it("uses one local recovery before a budgeted Slow Path fallback", () => {
    const router = new FastPathRouter();
    const budget = new TaskBudgetTracker("balanced");
    const recovery = router.routeStage({
      stage: "recover",
      profile: "balanced",
      intent,
      prediction: uncertainPrediction,
      hasLocalPlan: false,
      budget,
      recoveryAttempt: 0,
      failureReason: "Selector no longer matches.",
    });
    const fallback = router.routeStage({
      stage: "recover",
      profile: "balanced",
      intent,
      prediction: uncertainPrediction,
      hasLocalPlan: false,
      budget,
      recoveryAttempt: 1,
      failureReason: "Selector no longer matches.",
    });

    expect(recovery).toMatchObject({ path: "local_recovery" });
    expect(fallback).toMatchObject({
      path: "slow_planner",
      fallbackFrom: "local_recovery",
    });
  });

  it("caps provider calls and replaces a trace with the compact summary", async () => {
    let received: unknown;
    const router = new FastPathRouter({
      reason: async (request) => {
        received = request;
        return { decision: "blocked", message: "No safe plan." };
      },
    });
    const budget = new TaskBudgetTracker("balanced");
    const route = router.routeStage({
      stage: "plan",
      profile: "balanced",
      intent,
      prediction: uncertainPrediction,
      hasLocalPlan: false,
      budget,
    });
    const request = {
      taskId: "budgeted",
      userIntent: intent,
      uiState: {
        surface: "browser" as const,
        objects: [],
        signals: {},
        capturedAt: "2026-07-17T00:00:00.000Z",
      },
      recentTrace: [
        {
          eventId: "secret-trace",
          taskId: "budgeted",
          timestamp: "2026-07-17T00:00:00.000Z",
          type: "action_failed",
          payload: { password: "never-send" },
        },
      ],
      taskSummary: {
        goal: "Search [REDACTED_EMAIL]",
        completedSteps: ["observe"],
        verifiedEvidence: [],
        failureReasons: ["Selector changed"],
      },
      reason: "low_confidence" as const,
    };

    await expect(
      router.invokeRoutedSlowPath(route, request, budget),
    ).resolves.toEqual({
      decision: "blocked",
      message: "No safe plan.",
    });
    await expect(
      router.invokeRoutedSlowPath(route, request, budget),
    ).resolves.toBeUndefined();
    expect(received).toMatchObject({ recentTrace: [] });
    expect(JSON.stringify(received)).not.toContain("never-send");
  });

  it("does not upgrade fast_only and only permits vision on deliberative", () => {
    const router = new FastPathRouter();
    const fastOnly = router.routeStage({
      stage: "plan",
      profile: "fast_only",
      intent,
      prediction: uncertainPrediction,
      hasLocalPlan: false,
      budget: new TaskBudgetTracker("fast_only"),
    });
    const visual = router.routeStage({
      stage: "observe",
      profile: "deliberative",
      intent,
      prediction: uncertainPrediction,
      hasLocalPlan: false,
      budget: new TaskBudgetTracker("deliberative"),
      requiresVisualObservation: true,
      visualPlanningAvailable: true,
    });

    expect(fastOnly).toMatchObject({ path: "blocked" });
    expect(visual).toMatchObject({ path: "slow_vision_planner" });
  });

  it("makes risk and budgets override path capability", () => {
    const router = new FastPathRouter();
    const highRisk = router.routeStage({
      stage: "plan",
      profile: "deliberative",
      intent: { ...intent, riskLevel: "high", requiresConfirmation: true },
      prediction: uncertainPrediction,
      hasLocalPlan: false,
      budget: new TaskBudgetTracker("deliberative"),
    });
    const exhausted = router.routeStage({
      stage: "plan",
      profile: "balanced",
      intent,
      prediction: uncertainPrediction,
      hasLocalPlan: false,
      budget: new TaskBudgetTracker("balanced", {
        budget: { maxSlowPathCalls: 0 },
      }),
    });

    expect(highRisk).toMatchObject({ path: "ask_user" });
    expect(exhausted).toMatchObject({ path: "blocked" });
    expect(
      () =>
        new TaskBudgetTracker("fast_only", {
          budget: { maxSlowPathCalls: 1 },
        }),
    ).toThrow("cannot exceed");
  });
});
