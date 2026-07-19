import { describe, expect, it } from "vitest";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";

import { ClaudeSlowPathProvider } from "./claude-provider.js";
import { FastPathRouter } from "./fast-path-router.js";
import { OfflineEvaluationWorker } from "./offline-evaluation.js";
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
    url: "https://docs.example.test/search",
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

  it("executes verified Slow Path plans into a redacted candidate skill", async () => {
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

      expect(result?.learnedSkill).toBeUndefined();
      expect(result?.candidateSkill).toMatchObject({
        verifiedRunCount: 1,
        holdoutPassed: false,
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

  it("stores declared constraint values as stable candidate parameters", async () => {
    const database = createMemoryDatabase();
    try {
      const coordinator = new SlowPathLearningCoordinator(
        new SkillStore(database),
      );
      const executor = {
        execute: async () => ({
          execution: {
            success: true,
            method: "accessibility" as const,
            latencyMs: 1,
            evidence: ["filled"],
          },
          verification: { success: true, evidence: ["retained"] },
        }),
      };
      const run = async (taskId: string, query: string) =>
        coordinator.execute(
          {
            ...request,
            taskId,
            userIntent: {
              ...request.userIntent,
              constraints: { operation: "search", query },
            },
          },
          {
            decision: "propose_plan",
            message: "Search.",
            proposedActions: [
              {
                type: "fill",
                intent: "fill search query",
                target: "Search",
                value: query,
                methodPreference: ["accessibility"],
                riskLevel: "low",
              },
            ],
          },
          executor,
        );

      const first = await run("parameterized-1", "notebooks");
      const second = await run("parameterized-2", "databases");

      expect(second.candidateSkill).toMatchObject({
        name: first.candidateSkill?.name,
        verifiedRunCount: 2,
        definition: {
          constraints: {
            operation: "search",
            query: "{{constraints.query}}",
          },
          actions: [{ value: "{{constraints.query}}" }],
        },
      });
      expect(JSON.stringify(second.candidateSkill?.definition)).not.toContain(
        "notebooks",
      );
      expect(JSON.stringify(second.candidateSkill?.definition)).not.toContain(
        "databases",
      );
    } finally {
      database.close();
    }
  });

  it("publishes a sanitized shared skill only after candidate promotion", async () => {
    const database = createMemoryDatabase();
    try {
      const publications: unknown[] = [];
      const coordinator = new SlowPathLearningCoordinator(
        new SkillStore(database),
        {
          publish: async (publication) => {
            publications.push(publication);
          },
        },
      );
      const response = {
        decision: "propose_plan" as const,
        message: "Search.",
        proposedActions: [
          {
            type: "fill" as const,
            intent: "search",
            target: "Search",
            value: "notebooks",
            methodPreference: ["accessibility" as const],
            riskLevel: "low" as const,
          },
        ],
      };
      const executor = {
        execute: async () => ({
          execution: {
            success: true,
            method: "accessibility" as const,
            latencyMs: 1,
            evidence: ["filled"],
          },
          verification: { success: true, evidence: ["retained"] },
        }),
      };
      let candidateName = "";
      for (const taskId of ["candidate-1", "candidate-2", "candidate-3"]) {
        const result = await coordinator.execute(
          { ...request, taskId },
          response,
          executor,
        );
        candidateName = result.candidateSkill?.name ?? "";
      }

      expect(publications).toHaveLength(0);
      await new OfflineEvaluationWorker(
        new SkillStore(database),
      ).evaluateCandidate({
        candidateName,
        environment: "local_fixture",
        targetUrl: "http://127.0.0.1:4173/fixture",
        evaluationId: "candidate-holdout-1",
        uiFingerprint: "f".repeat(64),
        verifierVersion: "lhic-verifier-v1",
        verify: async () => ({ success: true, evidence: ["holdout verified"] }),
      });
      await coordinator.promoteCandidate(request, candidateName);

      expect(publications).toHaveLength(1);
      expect(JSON.stringify(publications)).not.toContain("notebooks");
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
