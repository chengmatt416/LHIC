import { describe, expect, it } from "vitest";

import type { BrowserExecutionPlan } from "@lhic/schema";
import { createActionApproval } from "@lhic/security";

import {
  executeBrowserPlan,
  resolveBrowserPlanVariables,
} from "./browser-plan-runner.js";

const plan: BrowserExecutionPlan = {
  schemaVersion: "browser-plan-v1",
  goal: "Search for a product",
  requiredVariables: [{ name: "query", prompt: "Search term" }],
  steps: [
    {
      id: "fill-query",
      action: {
        type: "fill",
        intent: "fill search query",
        target: "Search",
        value: "{{variables.query}}",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      },
      verification: {
        type: "dom",
        description: "search field remains visible",
        params: { selector: "#search" },
      },
    },
    {
      id: "submit-search",
      action: {
        type: "press",
        intent: "submit search",
        value: "Enter",
        methodPreference: ["keyboard"],
        riskLevel: "low",
      },
      verification: {
        type: "url",
        description: "search query URL",
        params: { contains: "q=" },
      },
    },
  ],
};

describe("browser plan runner", () => {
  it("stops at an activation and resumes without any planner callback", async () => {
    const executed: string[] = [];
    const resolved = resolveBrowserPlanVariables(plan, { query: "notebook" });
    const executor = {
      execute: async (
        action: BrowserExecutionPlan["steps"][number]["action"],
      ) => {
        executed.push(action.type);
        return {
          success: true,
          method:
            action.type === "press"
              ? ("keyboard" as const)
              : ("accessibility" as const),
          latencyMs: 1,
          evidence: ["Executed locally"],
        };
      },
    };
    const verifier = {
      verify: async () => ({
        success: true,
        evidence: ["Verified after action"],
      }),
    };

    const waiting = await executeBrowserPlan(resolved, executor, verifier, {
      requireActivationApproval: true,
    });
    expect(waiting).toMatchObject({
      status: "awaiting_approval",
      completedSteps: [{ stepId: "fill-query" }],
      nextStepIndex: 1,
      stepId: "submit-search",
    });
    expect(executed).toEqual(["fill"]);

    const approval = createActionApproval(
      resolved.steps[1]!.action,
      "demo-user",
    );
    const completed = await executeBrowserPlan(resolved, executor, verifier, {
      startAt: 1,
      approvals: { "submit-search": approval },
      requireActivationApproval: true,
    });
    expect(completed).toMatchObject({ status: "completed", nextStepIndex: 2 });
    expect(executed).toEqual(["fill", "press"]);
  });

  it("does not claim success when a required verifier fails", async () => {
    const resolved = resolveBrowserPlanVariables(plan, { query: "notebook" });
    const result = await executeBrowserPlan(
      { ...resolved, steps: [resolved.steps[0]!] },
      {
        execute: async () => ({
          success: true,
          method: "accessibility" as const,
          latencyMs: 1,
          evidence: ["Action completed"],
        }),
      },
      {
        verify: async () => ({
          success: false,
          evidence: [],
          error: "Expected page state was absent.",
        }),
      },
    );
    expect(result).toMatchObject({ status: "failed", stepId: "fill-query" });
  });

  it("requires all declared variables before local execution", () => {
    expect(() => resolveBrowserPlanVariables(plan, {})).toThrow("query");
  });

  it("refuses undeclared placeholders instead of typing them literally", () => {
    const malformed = {
      ...plan,
      requiredVariables: [],
    };
    expect(() => resolveBrowserPlanVariables(malformed, {})).toThrow(
      "undeclared variable query",
    );
  });
});
