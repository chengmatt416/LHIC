import { describe, expect, it } from "vitest";

import { ContextEngine } from "./context-engine.js";
import { toSlowPathSafeUiState, toStagePlan } from "./slow-path.js";
import { createTaskSummary } from "./task-summary.js";

const intent = {
  goal: "Search person@example.com for invoices",
  constraints: { operation: "search" },
  riskLevel: "low" as const,
  requiresConfirmation: false,
  missingInformation: [],
};

describe("task summaries and stage plans", () => {
  it("redacts model summaries and removes URL queries", () => {
    const summary = createTaskSummary({
      intent,
      uiState: {
        surface: "browser",
        url: "https://example.test/search?q=person@example.com",
        objects: [],
        signals: {},
        capturedAt: "2026-07-17T00:00:00.000Z",
      },
      completedSteps: ["observed"],
      verifiedEvidence: ["Found person@example.com"],
      failureReasons: ["Password secret must not be sent"],
      nextStage: "recover",
    });

    expect(JSON.stringify(summary)).not.toContain("person@example.com");
    expect(summary.currentLocation).toBe("https://example.test/search");
  });

  it("keeps compact context in the ContextEngine and creates executable stage plans", () => {
    const context = new ContextEngine("task-1", intent.goal);
    context.setUIState({
      surface: "browser",
      url: "https://example.test/search?q=secret",
      objects: [],
      signals: {},
      capturedAt: "2026-07-17T00:00:00.000Z",
    });
    context.completeStep("observed");
    context.recordVerification(["Search field visible"]);
    context.recordFailure("Selector changed");

    expect(context.summarize(intent, "recover")).toMatchObject({
      completedSteps: ["observed"],
      verifiedEvidence: ["Search field visible"],
      failureReasons: ["Selector changed"],
    });
    expect(
      toStagePlan(
        {
          decision: "propose_plan",
          message: "Fill the field.",
          proposedActions: [
            {
              type: "fill",
              intent: "fill search query",
              target: "Search",
              value: "books",
              methodPreference: ["accessibility"],
              riskLevel: "low",
            },
          ],
        },
        intent.goal,
      ),
    ).toMatchObject({
      schemaVersion: "stage-plan-v1",
      nextStage: "execute",
    });
  });

  it("removes typed values and opaque signals from planner UI context", () => {
    const safe = toSlowPathSafeUiState({
      surface: "browser",
      objects: [
        {
          id: "search",
          role: "textbox",
          label: "Search",
          value: "private-but-not-pii",
          source: "dom",
        },
      ],
      signals: { bearer: "opaque-secret" },
      capturedAt: "2026-07-17T00:00:00.000Z",
    });
    expect(safe).toMatchObject({
      objects: [{ id: "search", label: "Search" }],
      signals: {},
    });
    expect(safe.objects[0]?.value).toBeUndefined();
  });
});
