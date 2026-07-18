import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTraceEvents } from "@lhic/trace";
import type { SemanticAction } from "@lhic/schema";
import { describe, expect, it } from "vitest";

import { FastPathRouter } from "./fast-path-router.js";
import { MultiPathTaskController } from "./multi-path-task-controller.js";

const intent = {
  goal: "Find the release notes",
  constraints: { operation: "search" },
  riskLevel: "low" as const,
  requiresConfirmation: false,
  missingInformation: [],
};

const state = {
  surface: "browser" as const,
  url: "http://127.0.0.1:4173/release-notes",
  objects: [],
  signals: {},
  capturedAt: "2026-07-17T00:00:00.000Z",
};

const confidentPrediction = {
  predictedIntent: "search" as const,
  skillName: "search",
  confidence: 0.9,
  evidence: ["A local search skill is available."],
};

const localAction: SemanticAction = {
  type: "fill",
  intent: "fill the release notes search field",
  target: "input[type=search]",
  value: "release notes",
  methodPreference: ["dom"],
  riskLevel: "low",
};

const slowAction: SemanticAction = {
  type: "fill",
  intent: "fill the recovered release notes search field",
  target: "[aria-label='Search release notes']",
  value: "release notes",
  methodPreference: ["accessibility"],
  riskLevel: "low",
};

describe("MultiPathTaskController", () => {
  it("recovers locally once, then uses one budgeted planner call and local verified execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-multipath-"));
    const traceFilePath = join(directory, "trace.jsonl");
    let providerCalls = 0;
    let observationCount = 0;
    let executionCount = 0;
    try {
      const controller = new MultiPathTaskController({
        taskId: "multi-path-recovery",
        intent,
        prediction: confidentPrediction,
        profile: "balanced",
        config: { mode: "enabled", defaultProfile: "balanced" },
        traceFilePath,
        router: new FastPathRouter({
          reason: async (request) => {
            providerCalls += 1;
            expect(request.recentTrace).toEqual([]);
            expect(request.taskSummary).toMatchObject({
              completedSteps: ["observe"],
              failureReasons: ["Selector no longer matches."],
            });
            return {
              decision: "propose_plan",
              message: "Use the current accessibility label.",
              proposedActions: [slowAction],
            };
          },
        }),
        observe: async () => {
          observationCount += 1;
          return {
            ...state,
            capturedAt: `2026-07-17T00:00:0${observationCount}.000Z`,
          };
        },
        resolveLocalPlan: async () =>
          observationCount === 1 ? [localAction] : undefined,
        executor: {
          execute: async (action) => {
            executionCount += 1;
            if (action.target === localAction.target) {
              return {
                execution: {
                  success: false,
                  method: "dom",
                  latencyMs: 1,
                  evidence: [],
                  error: "Selector no longer matches.",
                },
                verification: {
                  success: false,
                  evidence: [],
                  error: "The action was not executed.",
                },
              };
            }
            return {
              execution: {
                success: true,
                method: "accessibility",
                latencyMs: 1,
                evidence: ["Filled the recovered field."],
              },
              verification: {
                success: true,
                evidence: ["Release notes result is ready."],
              },
            };
          },
        },
      });

      const result = await controller.run();
      const trace = await readTraceEvents(traceFilePath);

      expect(result).toMatchObject({
        status: "completed",
        budget: { slowPathCalls: 1 },
      });
      expect(providerCalls).toBe(1);
      expect(observationCount).toBe(2);
      expect(executionCount).toBe(2);
      expect(result.routes.map((route) => route.path)).toContain(
        "local_recovery",
      );
      expect(result.routes.map((route) => route.path)).toContain(
        "slow_planner",
      );
      expect(
        trace.filter((event) => event.type === "stage_routed"),
      ).toHaveLength(result.routes.length);
      expect(JSON.stringify(trace)).not.toContain("release notes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps fast_only model-free when no deterministic plan exists", async () => {
    let providerCalls = 0;
    const controller = new MultiPathTaskController({
      taskId: "fast-only",
      intent,
      prediction: confidentPrediction,
      profile: "fast_only",
      config: { mode: "enabled", defaultProfile: "fast_only" },
      router: new FastPathRouter({
        reason: async () => {
          providerCalls += 1;
          return { decision: "blocked", message: "must not be called" };
        },
      }),
      observe: async () => state,
      resolveLocalPlan: async () => undefined,
      executor: {
        execute: async () => {
          throw new Error("Fast-only must not execute an unplanned action.");
        },
      },
    });

    await expect(controller.run()).resolves.toMatchObject({
      status: "blocked",
      budget: { slowPathCalls: 0, imageInputs: 0 },
    });
    expect(providerCalls).toBe(0);
  });

  it("keeps shadow routing observational and executes the compatible local route", async () => {
    let providerCalls = 0;
    const controller = new MultiPathTaskController({
      taskId: "shadow-local",
      intent,
      prediction: confidentPrediction,
      profile: "fast_only",
      config: { mode: "shadow", defaultProfile: "fast_only" },
      router: new FastPathRouter({
        reason: async () => {
          providerCalls += 1;
          return { decision: "blocked", message: "must not be called" };
        },
      }),
      observe: async () => state,
      resolveLocalPlan: async () => [slowAction],
      executor: {
        execute: async () => ({
          execution: {
            success: true,
            method: "accessibility",
            latencyMs: 1,
            evidence: ["Filled field."],
          },
          verification: { success: true, evidence: ["Result ready."] },
        }),
      },
    });

    const result = await controller.run();
    expect(result.status).toBe("completed");
    expect(result.routes.every((route) => route.shadow)).toBe(true);
    expect(providerCalls).toBe(0);
  });

  it("fails closed for provider errors and planner proposals that require approval", async () => {
    let executed = false;
    const baseOptions = {
      taskId: "slow-policy",
      intent,
      prediction: confidentPrediction,
      profile: "balanced" as const,
      config: { mode: "enabled" as const, defaultProfile: "balanced" as const },
      observe: async () => state,
      resolveLocalPlan: async () => undefined,
      executor: {
        execute: async () => {
          executed = true;
          return {
            execution: {
              success: true,
              method: "accessibility" as const,
              latencyMs: 1,
              evidence: ["must not execute"],
            },
            verification: { success: true, evidence: ["must not verify"] },
          };
        },
      },
    };
    const unavailable = new MultiPathTaskController({
      ...baseOptions,
      router: new FastPathRouter({
        reason: async () => {
          throw new Error("provider outage");
        },
      }),
    });
    await expect(unavailable.run()).resolves.toMatchObject({
      status: "blocked",
      failureReason: "The budgeted planner was unavailable.",
    });

    const unsafeProposal = new MultiPathTaskController({
      ...baseOptions,
      taskId: "slow-policy-action",
      router: new FastPathRouter({
        reason: async () => ({
          decision: "propose_plan",
          message: "Delete the record.",
          proposedActions: [
            {
              type: "click",
              intent: "delete the record",
              target: "#delete",
              methodPreference: ["accessibility"],
              riskLevel: "high",
            },
          ],
        }),
      }),
    });
    await expect(unsafeProposal.run()).resolves.toMatchObject({
      status: "ask_user",
      budget: { slowPathCalls: 1 },
    });
    expect(executed).toBe(false);
  });
});
