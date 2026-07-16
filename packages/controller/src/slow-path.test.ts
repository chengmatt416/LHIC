import { describe, expect, it } from "vitest";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";

import { ClaudeSlowPathProvider } from "./claude-provider.js";
import { FastPathRouter } from "./fast-path-router.js";
import {
  compileSlowPathSkill,
  SlowPathLearningCoordinator,
} from "./slow-path-learning.js";

const request = {
  taskId: "slow-1",
  userIntent: {
    goal: "search",
    constraints: {},
    riskLevel: "low" as const,
    requiresConfirmation: false,
    missingInformation: [],
  },
  uiState: {
    surface: "browser" as const,
    objects: [],
    signals: {},
    capturedAt: "2026-07-15T00:00:00.000Z",
  },
  recentTrace: [],
  reason: "low_confidence" as const,
};

describe("Slow Path interfaces", () => {
  it("delegates a slow decision through a provider without binding Fast Path to a vendor", async () => {
    const router = new FastPathRouter({
      reason: async () => ({ decision: "ask_user", message: "Need a query." }),
    });
    const response = await router.invokeSlowPath(
      { path: "slow", reason: "ambiguous", confidence: 0.5 },
      request,
    );
    expect(response).toEqual({
      decision: "ask_user",
      message: "Need a query.",
    });
  });

  it("keeps the optional Claude adapter disabled by default without performing a request", async () => {
    const provider = new ClaudeSlowPathProvider({
      enabled: false,
      fetchImplementation: async () => {
        throw new Error("must not be called");
      },
    });
    await expect(provider.reason(request)).resolves.toEqual({
      decision: "blocked",
      message: "Claude Slow Path is disabled by default.",
    });
  });

  it("executes verified Slow Path plans and automatically learns a redacted skill", async () => {
    const database = createMemoryDatabase();
    try {
      const coordinator = new SlowPathLearningCoordinator(
        new SkillStore(database),
      );
      const router = new FastPathRouter(
        {
          reason: async () => ({
            decision: "propose_plan",
            message: "Fill the secure field.",
            proposedActions: [
              {
                type: "fill",
                intent: "fill password",
                target: "Password",
                value: "never-store-this",
                methodPreference: ["accessibility"],
                riskLevel: "low",
              },
            ],
          }),
        },
        coordinator,
      );
      const result = await router.executeSlowPath(
        { path: "slow", reason: "Needs a plan.", confidence: 0.4 },
        request,
        {
          execute: async () => ({
            execution: {
              success: true,
              method: "accessibility",
              latencyMs: 4,
              evidence: ["Field filled"],
            },
            verification: { success: true, evidence: ["Value retained"] },
          }),
        },
      );

      expect(result?.learnedSkill).toMatchObject({
        lifecycle: "verified",
        successCount: 1,
        definition: {
          compiler: "slow-path-v1",
          actions: [{ value: "[REDACTED]" }],
        },
      });
    } finally {
      database.close();
    }
  });

  it("does not save a plan when an action lacks successful verifier evidence", async () => {
    const database = createMemoryDatabase();
    try {
      const coordinator = new SlowPathLearningCoordinator(
        new SkillStore(database),
      );
      const result = await coordinator.execute(
        request,
        {
          decision: "propose_plan",
          message: "Try the action.",
          proposedActions: [
            {
              type: "press",
              intent: "submit",
              value: "Enter",
              methodPreference: ["keyboard"],
              riskLevel: "low",
            },
          ],
        },
        {
          execute: async () => ({
            execution: {
              success: true,
              method: "keyboard",
              latencyMs: 1,
              evidence: ["Pressed Enter"],
            },
            verification: { success: true, evidence: [] },
          }),
        },
      );

      expect(result.learnedSkill).toBeUndefined();
      expect(result.outcomes).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("refuses to compile plans with incomplete verifier evidence", () => {
    expect(() =>
      compileSlowPathSkill(
        request,
        [
          {
            type: "press",
            intent: "submit",
            value: "Enter",
            methodPreference: ["keyboard"],
            riskLevel: "low",
          },
        ],
        [
          {
            execution: {
              success: true,
              method: "keyboard",
              latencyMs: 1,
              evidence: ["Pressed Enter"],
            },
            verification: { success: true, evidence: [] },
          },
        ],
      ),
    ).toThrow("verifier evidence");
  });
});
