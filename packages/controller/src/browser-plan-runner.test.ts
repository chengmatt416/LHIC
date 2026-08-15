import { describe, expect, it } from "vitest";

import type { BrowserExecutionPlan } from "@lhic/schema";
import { createActionApproval, type ActionApproval } from "@lhic/security";

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

  it("binds batch approvals to the active execution scope", async () => {
    const resolved = resolveBrowserPlanVariables(plan, { query: "notebook" });
    let executions = 0;
    const approval = createActionApproval(
      resolved.steps[1]!.action,
      "operator@example.test",
      { scope: "different-task" },
    );
    const result = await executeBrowserPlan(
      resolved,
      {
        execute: async () => {
          executions += 1;
          return {
            success: true,
            method: "keyboard" as const,
            latencyMs: 1,
            evidence: ["Executed"],
          };
        },
      },
      { verify: async () => ({ success: true, evidence: ["Verified"] }) },
      {
        startAt: 1,
        approvals: { "submit-search": approval },
        requireActivationApproval: true,
        approvalScope: "active-task",
      },
    );

    expect(result).toMatchObject({
      status: "awaiting_approval",
      stepId: "submit-search",
    });
    expect(executions).toBe(0);
  });

  it("binds an upload receipt to the resolved caller-supplied file path", async () => {
    const uploadPlan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Upload an approved benchmark fixture",
      requiredVariables: [
        { name: "fixture", prompt: "Approved fixture file path" },
      ],
      steps: [
        {
          id: "upload-fixture",
          action: {
            type: "upload",
            intent: "upload the caller-selected fixture",
            target: "attachment",
            filePath: "{{variables.fixture}}",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "attachment is selected",
            params: { selector: "#attachment" },
          },
        },
      ],
    };
    const resolved = resolveBrowserPlanVariables(uploadPlan, {
      fixture: "/fixtures/document.txt",
    });
    const receipts: Array<ActionApproval | undefined> = [];
    const executor = {
      execute: async (
        action: BrowserExecutionPlan["steps"][number]["action"],
        approval?: ActionApproval,
      ) => {
        receipts.push(approval);
        return {
          success: true,
          method: "dom" as const,
          latencyMs: 1,
          evidence: [`Uploaded ${action.filePath}`],
        };
      },
    };
    const verifier = {
      verify: async () => ({
        success: true,
        evidence: ["Attachment selected"],
      }),
    };

    const waiting = await executeBrowserPlan(resolved, executor, verifier);
    expect(waiting).toMatchObject({
      status: "awaiting_approval",
      stepId: "upload-fixture",
      nextStepIndex: 0,
    });
    expect(receipts).toEqual([]);

    const unresolvedPathApproval = createActionApproval(
      uploadPlan.steps[0]!.action,
      "operator@example.test",
    );
    const mismatched = await executeBrowserPlan(resolved, executor, verifier, {
      approvals: { "upload-fixture": unresolvedPathApproval },
    });
    expect(mismatched).toMatchObject({
      status: "awaiting_approval",
      stepId: "upload-fixture",
    });
    expect(receipts).toEqual([]);

    const approval = createActionApproval(
      resolved.steps[0]!.action,
      "operator@example.test",
      { scope: "webarena-episode-1" },
    );
    if (waiting.status !== "awaiting_approval") {
      throw new Error("Upload plan did not produce an approval challenge.");
    }
    expect(waiting.approval.actionHash).toBe(approval.actionHash);
    const completed = await executeBrowserPlan(resolved, executor, verifier, {
      approvals: { "upload-fixture": approval },
      approvalScope: "webarena-episode-1",
    });

    expect(completed).toMatchObject({
      status: "completed",
      nextStepIndex: 1,
      completedSteps: [{ approvalReceipt: approval }],
    });
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

  it("returns resumable failures when execution boundaries reject", async () => {
    const resolved = resolveBrowserPlanVariables(plan, { query: "notebook" });
    const executorFailure = await executeBrowserPlan(
      { ...resolved, steps: [resolved.steps[0]!] },
      {
        execute: async () => {
          throw new Error("browser session closed");
        },
      },
      {
        verify: async () => ({ success: true, evidence: ["not reached"] }),
      },
    );
    expect(executorFailure).toMatchObject({
      status: "failed",
      nextStepIndex: 0,
      stepId: "fill-query",
      error: "Browser action executor failed: browser session closed",
    });

    const verifierFailure = await executeBrowserPlan(
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
        verify: async () => {
          throw new Error("page detached");
        },
      },
    );
    expect(verifierFailure).toMatchObject({
      status: "failed",
      nextStepIndex: 0,
      stepId: "fill-query",
      error: "Browser plan verifier failed: page detached",
    });
  });

  it("does not retry a verified plan step when optional learning fails", async () => {
    const resolved = resolveBrowserPlanVariables(plan, { query: "notebook" });
    let executions = 0;
    const result = await executeBrowserPlan(
      { ...resolved, steps: [resolved.steps[0]!] },
      {
        execute: async () => {
          executions += 1;
          return {
            success: true,
            method: "accessibility" as const,
            latencyMs: 1,
            evidence: ["Action completed"],
          };
        },
        rememberVerifiedAction: () => {
          throw new Error("learning store unavailable");
        },
      },
      {
        verify: async () => ({
          success: true,
          evidence: ["Verified after action"],
        }),
      },
    );

    expect(result).toMatchObject({ status: "completed", nextStepIndex: 1 });
    expect(executions).toBe(1);
  });
});
