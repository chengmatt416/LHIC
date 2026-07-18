import { describe, expect, it } from "vitest";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import type { BrowserExecutionPlan, NormalizedUIState } from "@lhic/schema";

import {
  findSimilarDemoSkill,
  learnDemoSkill,
  toModelSafeUiState,
} from "./demo-learning.js";

const state: NormalizedUIState = {
  surface: "browser",
  url: "https://example.test/search",
  title: "Search",
  objects: [
    {
      id: "query",
      role: "textbox",
      label: "Search",
      value: "private value",
      enabled: true,
      focused: false,
      source: "dom",
    },
  ],
  signals: {},
  capturedAt: "2026-07-17T00:00:00.000Z",
};

const plan: BrowserExecutionPlan = {
  schemaVersion: "browser-plan-v1",
  goal: "Search catalogue",
  requiredVariables: [],
  steps: [
    {
      id: "fill-search",
      action: {
        type: "fill",
        intent: "fill search",
        target: "Search",
        value: "notebooks",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      },
      verification: {
        type: "dom",
        description: "Search remains available",
        params: { selector: "#query" },
      },
    },
  ],
};

describe("demo learning", () => {
  it("stores a redacted verified template and retrieves it with local embeddings", async () => {
    const database = createMemoryDatabase();
    const embeddingEngine = { embed: async () => [1, 0, 0] };
    try {
      const skill = await learnDemoSkill(
        new SkillStore(database),
        embeddingEngine,
        "demo-learning-test-1",
        "Search notebooks for person@example.com",
        state,
        plan,
        [
          {
            stepId: "fill-search",
            execution: {
              success: true,
              method: "accessibility",
              latencyMs: 1,
              evidence: ["filled"],
            },
            verification: { success: true, evidence: ["field retained value"] },
          },
        ],
      );
      expect(JSON.stringify(skill.definition)).not.toContain("notebooks");
      expect(JSON.stringify(skill.definition)).not.toContain(
        "person@example.com",
      );
      const learnedPlan = (skill.definition as { plan: BrowserExecutionPlan })
        .plan;
      expect(learnedPlan.requiredVariables).toEqual([
        {
          name: "input-1",
          prompt: "Provide the value for fill search.",
        },
      ]);
      expect(learnedPlan.steps[0]?.action.value).toBe("{{variables.input-1}}");

      const match = await findSimilarDemoSkill(
        new SkillStore(database),
        embeddingEngine,
        "Search a similar catalogue query",
        state,
      );
      expect(skill).toMatchObject({ verifiedRunCount: 1, promoted: false });
      expect(match).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("removes all form values from model observations", () => {
    const safe = toModelSafeUiState(state);
    expect(JSON.stringify(safe)).not.toContain("private value");
    expect(safe.objects[0]?.value).toBeUndefined();
  });
});
