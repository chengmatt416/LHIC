import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  ActionExecutionResult,
  BrowserExecutionPlan,
  NormalizedUIState,
  SemanticAction,
} from "@lhic/schema";
import type { ActionApproval } from "@lhic/security";

import {
  callComputerUseTool,
  createComputerUseServer,
  createMcpRuntime,
  SerializedComputerUseSession,
  type ComputerUseActionResult,
  type ComputerUsePlanResult,
  type ComputerUseSession,
  type ComputerUseSnapshot,
  type ComputerUseStartResult,
} from "./index.js";

class FakeComputerUseSession implements ComputerUseSession {
  public readonly state: NormalizedUIState = {
    surface: "browser",
    url: "https://example.test/settings",
    title: "Example settings",
    objects: [
      {
        id: "email",
        role: "textbox",
        label: "Email",
        value: "person@example.com",
        enabled: true,
        focused: false,
        source: "dom",
        selector: "#email",
      },
    ],
    signals: {},
    capturedAt: "2026-07-15T00:00:00.000Z",
  };

  public action: SemanticAction | undefined;
  public approval: ActionApproval | undefined;
  public closed = false;
  public plan: BrowserExecutionPlan | undefined;
  public resumedApproval: ActionApproval | undefined;

  public async start(url?: string): Promise<ComputerUseStartResult> {
    return {
      state: { ...this.state, ...(url ? { url } : {}) },
      ...(url
        ? {
            navigation: this.successResult("api"),
          }
        : {}),
    };
  }

  public async observe(): Promise<ComputerUseSnapshot> {
    return { state: this.state };
  }

  public async act(
    action: SemanticAction,
    approval?: ActionApproval,
  ): Promise<ComputerUseActionResult> {
    this.action = action;
    this.approval = approval;
    return { result: this.successResult("dom"), state: this.state };
  }

  public async close(): Promise<void> {
    this.closed = true;
  }

  public async executePlan(
    plan: BrowserExecutionPlan,
  ): Promise<ComputerUsePlanResult> {
    this.plan = plan;
    return {
      state: this.state,
      result: {
        status: "awaiting_approval" as const,
        completedSteps: [],
        nextStepIndex: 0,
        stepId: plan.steps[0]!.id,
        approval: {
          approvalId: "pending",
          actionHash: "pending",
          approvedBy: "pending-human-approval",
          approvedAt: "2026-07-17T00:00:00.000Z",
          expiresAt: "2026-07-17T00:05:00.000Z",
        },
      },
    };
  }

  public async resumePlan(
    approval: ActionApproval,
  ): Promise<ComputerUsePlanResult> {
    this.resumedApproval = approval;
    return {
      state: this.state,
      result: {
        status: "completed" as const,
        completedSteps: [],
        nextStepIndex: 1,
      },
    };
  }

  private successResult(method: "api" | "dom"): ActionExecutionResult {
    return {
      success: true,
      method,
      latencyMs: 1,
      evidence: ["Fixture action completed."],
    };
  }
}

class CompletedPlanComputerUseSession extends FakeComputerUseSession {
  public async executePlan(
    plan: BrowserExecutionPlan,
  ): Promise<ComputerUsePlanResult> {
    this.plan = plan;
    return {
      state: this.state,
      result: {
        status: "completed" as const,
        completedSteps: plan.steps.map((step) => ({
          stepId: step.id,
          execution: {
            success: true,
            method: "accessibility" as const,
            latencyMs: 1,
            evidence: ["Action completed."],
          },
          verification: {
            success: true,
            evidence: ["Verifier observed the expected state."],
          },
        })),
        nextStepIndex: plan.steps.length,
      },
    };
  }

  public getStatus() {
    return { active: true, taskId: "mcp-verified-plan-1" };
  }
}

class ResumedPlanComputerUseSession extends FakeComputerUseSession {
  public getStatus() {
    return { active: true, taskId: "mcp-resumed-plan-1" };
  }

  public async resumePlan(
    approval: ActionApproval,
  ): Promise<ComputerUsePlanResult> {
    this.resumedApproval = approval;
    const plan = this.plan;
    if (!plan) throw new Error("No pending plan.");
    return {
      state: this.state,
      result: {
        status: "completed",
        completedSteps: plan.steps.map((step) => ({
          stepId: step.id,
          execution: {
            success: true,
            method: "keyboard",
            latencyMs: 1,
            evidence: ["Action completed."],
          },
          verification: {
            success: true,
            evidence: ["Verifier observed the expected state."],
          },
        })),
        nextStepIndex: plan.steps.length,
      },
    };
  }
}

describe("LHIC computer-use MCP server", () => {
  it("advertises the Antigravity browser computer-use tools through MCP", async () => {
    const session = new FakeComputerUseSession();
    const server = createComputerUseServer(session);
    const client = new Client(
      { name: "lhic-mcp-test-client", version: "0.1.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name)).toEqual([
        "lhic_browser_start",
        "lhic_browser_observe",
        "lhic_browser_act",
        "lhic_browser_execute_plan",
        "lhic_browser_resume_plan",
        "lhic_browser_close",
        "lhic_runtime_status",
        "lhic_skills_list",
        "lhic_shared_skills_list",
        "lhic_selector_memory_list",
      ]);
      expect(result.tools[1]).toMatchObject({
        annotations: { readOnlyHint: true, idempotentHint: true },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("executes validated semantic actions and omits browser input values", async () => {
    const session = new FakeComputerUseSession();
    const response = await callComputerUseTool(session, "lhic_browser_act", {
      action: {
        type: "click",
        intent: "open profile settings",
        target: "#profile",
        methodPreference: ["dom", "accessibility"],
        riskLevel: "low",
      },
    });

    expect(session.action).toMatchObject({
      type: "click",
      target: "#profile",
      riskLevel: "low",
    });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      state: { title: "Example settings" },
    });
    expect(JSON.stringify(response.structuredContent)).not.toContain(
      "person@example.com",
    );
    const text =
      response.content[0]?.type === "text" ? response.content[0].text : "";
    expect(text).toContain("Example settings");
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain('"value"');
  });

  it("rejects malformed actions without invoking the browser", async () => {
    const session = new FakeComputerUseSession();
    const response = await callComputerUseTool(session, "lhic_browser_act", {
      action: { type: "click" },
    });

    expect(response.isError).toBe(true);
    expect(session.action).toBeUndefined();
  });

  it("rejects semantic actions that the direct browser executor cannot run", async () => {
    const session = new FakeComputerUseSession();
    const response = await callComputerUseTool(session, "lhic_browser_act", {
      action: {
        type: "download",
        intent: "download the export",
        methodPreference: ["api"],
        riskLevel: "low",
      },
    });

    expect(response.isError).toBe(true);
    expect(session.action).toBeUndefined();
  });

  it("passes a complete Fast Path plan to the batch boundary and resumes only with approval", async () => {
    const session = new FakeComputerUseSession();
    const plan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Search",
      requiredVariables: [],
      steps: [
        {
          id: "submit",
          action: {
            type: "press",
            intent: "submit search",
            value: "Enter",
            methodPreference: ["keyboard"],
            riskLevel: "low",
          },
          verification: {
            type: "url",
            description: "search result URL",
            params: { contains: "q=" },
          },
        },
      ],
    };
    const execution = await callComputerUseTool(
      session,
      "lhic_browser_execute_plan",
      { plan },
    );
    expect(execution.structuredContent).toMatchObject({
      result: { status: "awaiting_approval", stepId: "submit" },
    });
    expect(session.plan).toEqual(plan);

    const approval: ActionApproval = {
      approvalId: "approved",
      actionHash: "hash",
      approvedBy: "demo-user",
      approvedAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-07-17T00:05:00.000Z",
    };
    const resumed = await callComputerUseTool(
      session,
      "lhic_browser_resume_plan",
      { approval },
    );
    expect(resumed.structuredContent).toMatchObject({
      result: { status: "completed" },
    });
    expect(session.resumedApproval).toEqual(approval);
  });

  it("records a fully verified MCP plan as a local parameterized candidate Skill", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-mcp-learning-"));
    const databaseFile = join(directory, "memory", "skills.sqlite");
    const runtime = await createMcpRuntime(databaseFile, {
      embeddingEngine: { embed: async () => [1, 0, 0] },
    });
    const session = new CompletedPlanComputerUseSession();
    const plan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Search the catalogue",
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
            description: "Search field is available",
            params: { selector: "#search" },
          },
        },
      ],
    };

    try {
      const response = await callComputerUseTool(
        session,
        "lhic_browser_execute_plan",
        { plan },
        runtime,
      );
      const learning = response.structuredContent?.learning as
        | {
            status: string;
            candidateName?: string;
            verifiedRunCount?: number;
            promotion?: string;
          }
        | undefined;
      expect(learning).toMatchObject({
        status: "recorded",
        verifiedRunCount: 1,
        promotion: "requires_three_independent_runs_and_holdout",
      });
      expect(learning?.candidateName).toEqual(expect.any(String));

      const candidate = runtime.skillStore.getCandidate(
        learning?.candidateName ?? "",
      );
      expect(candidate).toMatchObject({
        verifiedRunCount: 1,
        promoted: false,
      });
      expect(JSON.stringify(candidate?.definition)).not.toContain("notebooks");
      expect(JSON.stringify(candidate?.definition)).not.toContain(
        "person@example.com",
      );
      expect(
        (
          candidate?.definition as {
            plan: BrowserExecutionPlan;
          }
        ).plan.requiredVariables,
      ).toEqual([
        {
          name: "input-1",
          prompt: "Provide the value for fill search.",
        },
      ]);
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("trains only after an approval-resumed MCP plan completes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-mcp-resume-"));
    const runtime = await createMcpRuntime(join(directory, "skills.sqlite"), {
      embeddingEngine: { embed: async () => [1, 0, 0] },
    });
    const session = new ResumedPlanComputerUseSession();
    const plan: BrowserExecutionPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Submit search",
      requiredVariables: [],
      steps: [
        {
          id: "submit",
          action: {
            type: "press",
            intent: "submit search",
            value: "Enter",
            methodPreference: ["keyboard"],
            riskLevel: "low",
          },
          verification: {
            type: "url",
            description: "Search result URL",
            params: { contains: "q=" },
          },
        },
      ],
    };
    const approval: ActionApproval = {
      approvalId: "approved",
      actionHash: "hash",
      approvedBy: "demo-user",
      approvedAt: "2026-07-17T00:00:00.000Z",
      expiresAt: "2026-07-17T00:05:00.000Z",
    };

    try {
      const waiting = await callComputerUseTool(
        session,
        "lhic_browser_execute_plan",
        { plan },
        runtime,
      );
      expect(waiting.structuredContent?.learning).toMatchObject({
        status: "skipped",
      });

      const completed = await callComputerUseTool(
        session,
        "lhic_browser_resume_plan",
        { approval },
        runtime,
      );
      expect(completed.structuredContent?.learning).toMatchObject({
        status: "recorded",
        verifiedRunCount: 1,
      });
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("serializes concurrent actions against one browser session", async () => {
    const delegate = new FakeComputerUseSession();
    let inFlight = 0;
    let maxInFlight = 0;
    const session = new SerializedComputerUseSession({
      start: (url) => delegate.start(url),
      observe: () => delegate.observe(),
      act: async (action, approval) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return delegate.act(action, approval);
      },
      close: () => delegate.close(),
    });
    const action = {
      type: "click" as const,
      intent: "open settings",
      target: "#settings",
      methodPreference: ["dom" as const],
      riskLevel: "low" as const,
    };

    await Promise.all([session.act(action), session.act(action)]);

    expect(maxInFlight).toBe(1);
  });

  it("reports local learning state and returns redacted skill summaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-mcp-runtime-"));
    const databaseFile = join(directory, "memory", "skills.sqlite");
    const runtime = await createMcpRuntime(databaseFile);
    const session = new FakeComputerUseSession();

    try {
      const status = await callComputerUseTool(
        session,
        "lhic_runtime_status",
        {},
        runtime,
      );
      expect(status.structuredContent).toMatchObject({
        browserSession: { active: false },
        fastPath: { usesLLM: false, usesMcp: false },
        learning: {
          enabled: true,
          databaseFile,
          skillCount: 6,
          selectorCandidateCount: 0,
        },
      });

      const skills = await callComputerUseTool(
        session,
        "lhic_skills_list",
        { limit: 2 },
        runtime,
      );
      expect(skills.structuredContent).toMatchObject({
        databaseFile,
        returned: 2,
      });
      const listedSkills = skills.structuredContent?.skills as
        unknown[] | undefined;
      expect(listedSkills).toBeInstanceOf(Array);
      expect(listedSkills?.[0]).toMatchObject({
        name: expect.any(String),
        lifecycle: "draft",
        successCount: 0,
      });
      expect(JSON.stringify(skills.structuredContent)).not.toContain(
        "definition",
      );

      const sharedSkills = await callComputerUseTool(
        session,
        "lhic_shared_skills_list",
        {},
        runtime,
      );
      expect(sharedSkills.isError).toBe(true);

      runtime.selectorMemory.remember(
        {
          skillName: "fill",
          target: "Search query",
          selector: "#search-query",
        },
        { success: true, evidence: ["Field retained the value"] },
      );
      const selectors = await callComputerUseTool(
        session,
        "lhic_selector_memory_list",
        {},
        runtime,
      );
      expect(selectors.structuredContent).toMatchObject({
        databaseFile,
        returned: 1,
        selectors: [
          {
            skillName: "fill",
            target: "Search query",
            successCount: 1,
          },
        ],
      });
      expect(JSON.stringify(selectors.structuredContent)).not.toContain(
        "#search-query",
      );
    } finally {
      runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
