import { describe, expect, it, vi } from "vitest";

import type { BrowserRunResult } from "./desktop-browser-runner.js";
import type { GlobalRunResult } from "./desktop-global-runner.js";
import type { TaskService } from "./task-service.js";
import { OmpHostRunner } from "./omp-host-runner.js";

const browserPlan = {
  schemaVersion: "browser-plan-v1",
  goal: "Open documentation",
  requiredVariables: [],
  steps: [
    {
      id: "open-docs",
      action: {
        type: "navigate",
        intent: "Open documentation",
        target: "https://docs.example.test/",
        methodPreference: ["api"],
        riskLevel: "low",
      },
      verification: {
        type: "url",
        description: "Documentation URL is open",
        params: { equals: "https://docs.example.test/" },
      },
    },
  ],
};

const desktopPlan = {
  schemaVersion: "desktop-plan-v1",
  goal: "Open the calculator",
  requiredVariables: [],
  steps: [
    {
      id: "open-calc",
      action: {
        type: "os_type",
        intent: "Open the calculator",
        text: "calculator",
        methodPreference: ["keyboard"],
        riskLevel: "low",
      },
      verification: {
        type: "os",
        description: "Calculator window is visible",
        params: {},
      },
    },
  ],
};

function completedBrowser(): BrowserRunResult {
  return {
    status: "completed",
    message: "All browser steps completed with verifier evidence.",
    evidence: ["Browser execution session opened locally.", "URL verified"],
    proposal: {
      stepCount: 1,
      steps: [
        {
          id: "open-docs",
          action: "navigate",
          intent: "Open documentation",
          riskLevel: "low",
          verifier: "Documentation URL is open",
        },
      ],
    },
  };
}

function completedDesktop(): GlobalRunResult {
  return {
    status: "completed",
    message: "All desktop steps completed with local verifier evidence.",
    evidence: ["Desktop execution session prepared locally."],
    proposal: {
      stepCount: 1,
      steps: [
        {
          id: "open-calc",
          action: "os_type",
          intent: "Open the calculator",
          riskLevel: "low",
          verifier: "Calculator window is visible",
        },
      ],
    },
  };
}

function awaitingApproval(): BrowserRunResult {
  return {
    status: "awaiting_approval",
    message: "Approval is required before step 1.",
    evidence: ["Browser execution session opened locally."],
    proposal: {
      stepCount: 1,
      steps: [
        {
          id: "open-docs",
          action: "navigate",
          intent: "Open documentation",
          riskLevel: "low",
          verifier: "Documentation URL is open",
        },
      ],
    },
  };
}

interface RunnerHarness {
  runner: OmpHostRunner;
  results: Array<{ callId: string; result: Record<string, unknown>; isError: boolean }>;
  updates: Array<{ callId: string; partialResult: Record<string, unknown> }>;
  approvals: Array<{ callId: string; toolName: string }>;
}

function harness(tasks: Partial<TaskService>): RunnerHarness {
  const results: RunnerHarness["results"] = [];
  const updates: RunnerHarness["updates"] = [];
  const approvals: RunnerHarness["approvals"] = [];
  const runner = new OmpHostRunner(
    tasks as TaskService,
    (call) => approvals.push({ callId: call.callId, toolName: call.toolName }),
    {
      result: (callId, result, isError) =>
        results.push({ callId, result, isError }),
      update: (callId, partialResult) =>
        updates.push({ callId, partialResult }),
    },
  );
  return { runner, results, updates, approvals };
}

describe("OmpHostRunner", () => {
  it("dispatches browser plans to the browser runner and emits completed results", async () => {
    const executeOmpBrowserPlan = vi.fn(async () => completedBrowser());
    const { runner, results } = harness({ executeOmpBrowserPlan });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_1",
      toolCallId: "toolu_1",
      toolName: "lhic_browser_execute",
      arguments: { plan: browserPlan },
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(executeOmpBrowserPlan).toHaveBeenCalledOnce();
    expect(results[0]?.callId).toBe("host_1");
    expect(results[0]?.isError).toBe(false);
    const text = (results[0]?.result.content as Array<{ text: string }>)[0]?.text;
    const payload = JSON.parse(text) as { status: string; message: string; evidence: string[] };
    expect(payload.status).toBe("completed");
    expect(payload.evidence.length).toBeGreaterThan(0);
  });

  it("dispatches desktop plans to the global runner", async () => {
    const executeOmpDesktopPlan = vi.fn(async () => completedDesktop());
    const { runner, results } = harness({ executeOmpDesktopPlan });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_2",
      toolCallId: "toolu_2",
      toolName: "lhic_desktop_execute",
      arguments: { plan: desktopPlan },
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(executeOmpDesktopPlan).toHaveBeenCalledOnce();
    expect(results[0]?.isError).toBe(false);
  });

  it("surfaces awaiting-approval results as approval calls with a waiting update", async () => {
    const executeOmpBrowserPlan = vi.fn(async () => awaitingApproval());
    const { runner, approvals, updates } = harness({ executeOmpBrowserPlan });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_3",
      toolCallId: "toolu_3",
      toolName: "lhic_browser_execute",
      arguments: { plan: browserPlan },
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({ callId: "host_3", toolName: "lhic_browser_execute" });
    expect(updates[0]?.callId).toBe("host_3");
    expect(updates[0]?.partialResult.partialResult.content[0].text).toBe(
      "Waiting for approval…",
    );
  });

  it("approves a pending host tool and emits the follow-up result", async () => {
    const executeOmpBrowserPlan = vi.fn(async () => awaitingApproval());
    const approveOmpBrowserPlan = vi.fn(async () => completedBrowser());
    const { runner, results, approvals } = harness({
      executeOmpBrowserPlan,
      approveOmpBrowserPlan,
    });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_4",
      toolCallId: "toolu_4",
      toolName: "lhic_browser_execute",
      arguments: { plan: browserPlan },
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await runner.approve("host_4", "alice");
    expect(approveOmpBrowserPlan).toHaveBeenCalledWith(
      expect.any(String),
      { approvedBy: "alice" },
    );
    expect(results[0]?.isError).toBe(false);
  });

  it("rejects a pending host tool by cancelling the runner", async () => {
    const executeOmpBrowserPlan = vi.fn(async () => awaitingApproval());
    const cancelOmpBrowserPlan = vi.fn(async () => undefined);
    const { runner, results, approvals } = harness({
      executeOmpBrowserPlan,
      cancelOmpBrowserPlan,
    });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_5",
      toolCallId: "toolu_5",
      toolName: "lhic_browser_execute",
      arguments: { plan: browserPlan },
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    await runner.reject("host_5");
    expect(cancelOmpBrowserPlan).toHaveBeenCalledOnce();
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.result.content[0].text).toBe("Rejected by user.");
  });

  it("cancels the runner on an inbound host_tool_cancel", async () => {
    const executeOmpBrowserPlan = vi.fn(async () => awaitingApproval());
    const cancelOmpBrowserPlan = vi.fn(async () => undefined);
    const { runner, approvals } = harness({
      executeOmpBrowserPlan,
      cancelOmpBrowserPlan,
    });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_6",
      toolCallId: "toolu_6",
      toolName: "lhic_browser_execute",
      arguments: { plan: browserPlan },
    });
    await vi.waitFor(() => expect(approvals).toHaveLength(1));
    runner.handleHostToolCall({ type: "host_tool_cancel", targetId: "host_6" });
    expect(cancelOmpBrowserPlan).toHaveBeenCalledOnce();
  });

  it("rejects unknown tool names without touching the runners", async () => {
    const executeOmpBrowserPlan = vi.fn();
    const { runner, results } = harness({ executeOmpBrowserPlan });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_7",
      toolCallId: "toolu_7",
      toolName: "not_a_lhic_tool",
      arguments: {},
    });
    expect(executeOmpBrowserPlan).not.toHaveBeenCalled();
    expect(results[0]?.isError).toBe(true);
  });

  it("emits isError results when a runner rejects", async () => {
    const executeOmpBrowserPlan = vi.fn(async () => {
      throw new Error("browser failed to launch");
    });
    const { runner, results } = harness({ executeOmpBrowserPlan });
    runner.handleHostToolCall({
      type: "host_tool_call",
      id: "host_8",
      toolCallId: "toolu_8",
      toolName: "lhic_browser_execute",
      arguments: { plan: browserPlan },
    });
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.result.content[0].text).toContain("browser failed");
  });
});
