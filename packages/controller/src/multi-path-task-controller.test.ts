import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTraceEvents } from "@lhic/trace";
import type { SemanticAction } from "@lhic/schema";
import { describe, expect, it, vi } from "vitest";

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
            expect(request.uiState.capturedAt).toBe("2026-07-17T00:00:03.000Z");
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
          observationCount <= 2 ? [localAction] : undefined,
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
      expect(observationCount).toBe(3);
      expect(executionCount).toBe(3);
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

  it("propagates provider decisions and executor exceptions as terminal results", async () => {
    const baseOptions = {
      taskId: "core-error-propagation",
      intent,
      prediction: confidentPrediction,
      profile: "balanced" as const,
      config: { mode: "enabled" as const, defaultProfile: "balanced" as const },
      observe: async () => state,
      resolveLocalPlan: async () => undefined,
      executor: {
        execute: async () => {
          throw new Error("must not execute");
        },
      },
    };
    const providerBlocked = new MultiPathTaskController({
      ...baseOptions,
      router: new FastPathRouter({
        reason: async () => ({
          decision: "blocked",
          message: "The current state has no safe continuation.",
        }),
      }),
    });
    await expect(providerBlocked.run()).resolves.toMatchObject({
      status: "blocked",
      failureReason: "The current state has no safe continuation.",
    });

    const executorFailed = new MultiPathTaskController({
      ...baseOptions,
      taskId: "executor-exception",
      profile: "fast_only",
      config: { mode: "enabled", defaultProfile: "fast_only" },
      resolveLocalPlan: async () => [localAction],
    });
    await expect(executorFailed.run()).resolves.toMatchObject({
      status: "failed",
      failureReason: "Controller operation failed: must not execute",
      summary: {
        failureReasons: ["Controller operation failed: must not execute"],
      },
    });
  });

  it("does not retry a verified action when optional learning fails", async () => {
    let executions = 0;
    const controller = new MultiPathTaskController({
      taskId: "optional-learning-failure",
      intent,
      prediction: confidentPrediction,
      profile: "fast_only",
      config: { mode: "enabled", defaultProfile: "fast_only" },
      observe: async () => state,
      resolveLocalPlan: async () => [localAction],
      executor: {
        execute: async () => {
          executions += 1;
          return {
            execution: {
              success: true,
              method: "dom" as const,
              latencyMs: 1,
              evidence: ["Filled field."],
            },
            verification: { success: true, evidence: ["Result ready."] },
          };
        },
        rememberVerifiedAction: () => {
          throw new Error("learning store unavailable");
        },
      },
    });

    await expect(controller.run()).resolves.toMatchObject({
      status: "completed",
    });
    expect(executions).toBe(1);
  });

  it("bounds a never-settling observation and aborts the callback", async () => {
    vi.useFakeTimers();
    try {
      let observationSignal: AbortSignal | undefined;
      const controller = new MultiPathTaskController({
        taskId: "observe-timeout",
        intent,
        prediction: confidentPrediction,
        profile: "fast_only",
        config: { mode: "enabled", defaultProfile: "fast_only" },
        budget: { budget: { maxWallClockMs: 20 } },
        observe: (signal) => {
          observationSignal = signal;
          return Promise.withResolvers<never>().promise;
        },
        resolveLocalPlan: async () => [localAction],
        executor: {
          execute: async () => {
            throw new Error("must not execute");
          },
        },
      });

      const result = controller.run();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failureReason:
          "Controller operation failed: observe timed out after 20 ms.",
        summary: {
          failureReasons: [
            "Controller operation failed: observe timed out after 20 ms.",
          ],
        },
      });
      expect(observationSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds never-settling local planning and passes its abort signal", async () => {
    vi.useFakeTimers();
    try {
      let planningSignal: AbortSignal | undefined;
      const controller = new MultiPathTaskController({
        taskId: "local-plan-timeout",
        intent,
        prediction: confidentPrediction,
        profile: "fast_only",
        config: { mode: "enabled", defaultProfile: "fast_only" },
        budget: { budget: { maxWallClockMs: 20 } },
        observe: async () => state,
        resolveLocalPlan: (_state, signal) => {
          planningSignal = signal;
          return Promise.withResolvers<never>().promise;
        },
        executor: {
          execute: async () => {
            throw new Error("must not execute");
          },
        },
      });

      const result = controller.run();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failureReason:
          "Controller operation failed: local planning timed out after 20 ms.",
      });
      expect(planningSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a never-settling routed provider with the task budget", async () => {
    vi.useFakeTimers();
    try {
      let providerSignal: AbortSignal | undefined;
      const controller = new MultiPathTaskController({
        taskId: "provider-timeout",
        intent,
        prediction: confidentPrediction,
        profile: "balanced",
        config: { mode: "enabled", defaultProfile: "balanced" },
        budget: { budget: { maxWallClockMs: 20 } },
        router: new FastPathRouter({
          reason: (_request, signal) => {
            providerSignal = signal;
            return Promise.withResolvers<never>().promise;
          },
        }),
        observe: async () => state,
        resolveLocalPlan: async () => undefined,
        executor: {
          execute: async () => {
            throw new Error("must not execute");
          },
        },
      });

      const result = controller.run();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);

      await expect(result).resolves.toMatchObject({
        status: "blocked",
        failureReason:
          "The budgeted planner was unavailable: Slow Path planning timed out after 20 ms.",
      });
      expect(providerSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not replay an action whose execution times out", async () => {
    vi.useFakeTimers();
    try {
      let executions = 0;
      let executionSignal: AbortSignal | undefined;
      const controller = new MultiPathTaskController({
        taskId: "execute-timeout",
        intent,
        prediction: confidentPrediction,
        profile: "fast_only",
        config: { mode: "enabled", defaultProfile: "fast_only" },
        budget: { budget: { maxWallClockMs: 20 } },
        observe: async () => state,
        resolveLocalPlan: async () => [localAction],
        executor: {
          execute: (_action, signal) => {
            executions += 1;
            executionSignal = signal;
            return Promise.withResolvers<never>().promise;
          },
        },
      });

      const result = controller.run();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);

      await expect(result).resolves.toMatchObject({
        status: "failed",
        failureReason:
          "Controller operation failed: execute fill timed out after 20 ms.",
        outcomes: [],
      });
      expect(executions).toBe(1);
      expect(executionSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates external cancellation into the active stage", async () => {
    const cancellation = new AbortController();
    const started = Promise.withResolvers<void>();
    let observationSignal: AbortSignal | undefined;
    const controller = new MultiPathTaskController({
      taskId: "observe-aborted",
      intent,
      prediction: confidentPrediction,
      profile: "fast_only",
      config: { mode: "enabled", defaultProfile: "fast_only" },
      signal: cancellation.signal,
      observe: (signal) => {
        observationSignal = signal;
        started.resolve();
        return Promise.withResolvers<never>().promise;
      },
      resolveLocalPlan: async () => [localAction],
      executor: {
        execute: async () => {
          throw new Error("must not execute");
        },
      },
    });

    const result = controller.run();
    await started.promise;
    cancellation.abort();

    await expect(result).resolves.toMatchObject({
      status: "failed",
      failureReason: "Controller operation failed: observe was aborted.",
    });
    expect(observationSignal?.aborted).toBe(true);
  });
});
