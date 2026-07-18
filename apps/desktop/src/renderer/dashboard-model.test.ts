import { describe, expect, it } from "vitest";

import type { DashboardSnapshot } from "../shared/contracts.js";

import { createDashboardOverview } from "./dashboard-model.js";

const snapshot: DashboardSnapshot = {
  runtime: {
    workspaceRoot: "/workspace",
    fastPathModelFree: true,
    runningJobs: 0,
  },
  skills: [],
  sharedLibrary: {
    configured: false,
    enabled: false,
    cachedSkillCount: 0,
    pendingSubmissionCount: 0,
  },
  sources: [],
  mcp: [],
  recentEvents: [],
};

describe("dashboard overview", () => {
  it("prioritizes an approval gate ahead of setup guidance", () => {
    const overview = createDashboardOverview({
      ...snapshot,
      recentEvents: [
        {
          commandId: "task-1",
          status: "awaiting_approval",
          message: "Approval is required before submission.",
          createdAt: "2026-07-18T00:00:00.000Z",
        },
      ],
    });

    expect(overview.priority).toMatchObject({
      title: "Review pending approval",
      destination: "tasks",
      status: "awaiting_approval",
    });
    expect(overview.attention).toMatchObject([
      { title: "Task awaits approval", status: "awaiting_approval" },
    ]);
  });

  it("guides an unprepared workspace to configure its first execution path", () => {
    const overview = createDashboardOverview(snapshot);

    expect(overview.priority).toMatchObject({
      title: "Prepare the first execution path",
      actionLabel: "Configure planner",
      destination: "tasks",
    });
    expect(overview.readiness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skills", state: "attention" }),
        expect.objectContaining({ id: "planners", state: "attention" }),
      ]),
    );
  });

  it("keeps a ready local workspace focused on the task console", () => {
    const overview = createDashboardOverview({
      ...snapshot,
      skills: [
        {
          name: "local-search",
          source: "local",
          status: "ready",
          fastPathEligible: true,
        },
      ],
      sources: [
        {
          id: "codex-cli",
          kind: "codex-cli",
          label: "Codex CLI",
          enabled: true,
        },
      ],
    });

    expect(overview.priority).toMatchObject({
      title: "Start a guarded task",
      destination: "tasks",
      status: "ready",
    });
    expect(overview.readiness).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skills", state: "ready" }),
        expect.objectContaining({ id: "planners", state: "ready" }),
      ]),
    );
  });
});
