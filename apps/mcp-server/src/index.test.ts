import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type {
  ActionExecutionResult,
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

  private successResult(method: "api" | "dom"): ActionExecutionResult {
    return {
      success: true,
      method,
      latencyMs: 1,
      evidence: ["Fixture action completed."],
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
