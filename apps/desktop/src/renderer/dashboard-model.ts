import type { CommandEvent, DashboardSnapshot } from "../shared/contracts.js";

export type DashboardDestination = "skills" | "tasks" | "mcp" | "game";

export type DashboardReadinessState =
  "ready" | "active" | "attention" | "inactive";

export interface DashboardPriority {
  title: string;
  detail: string;
  actionLabel: string;
  destination: DashboardDestination;
  status: "ready" | "awaiting_approval" | "proposed" | "running" | "blocked";
}

export interface DashboardReadinessItem {
  id: string;
  label: string;
  detail: string;
  state: DashboardReadinessState;
  destination: DashboardDestination;
}

export interface DashboardAttentionItem {
  id: string;
  title: string;
  detail: string;
  destination: DashboardDestination;
  status: CommandEvent["status"] | "pending";
}

export interface DashboardOverview {
  fastPathSkillCount: number;
  sharedSkillCount: number;
  detectedMcpCount: number;
  enabledSourceCount: number;
  priority: DashboardPriority;
  readiness: DashboardReadinessItem[];
  attention: DashboardAttentionItem[];
}

const activeTaskStatuses = new Set<CommandEvent["status"]>([
  "queued",
  "running",
  "awaiting_approval",
  "proposed",
  "blocked",
]);

/**
 * Keeps the Dashboard's next-step guidance deterministic and derived only from
 * local state. It never admits a task, invokes a planner, or changes runtime
 * configuration.
 */
export function createDashboardOverview(
  snapshot: DashboardSnapshot,
): DashboardOverview {
  const fastPathSkillCount = snapshot.skills.filter(
    (skill) => skill.fastPathEligible,
  ).length;
  const sharedSkillCount = snapshot.skills.filter(
    (skill) => skill.source === "shared",
  ).length;
  const detectedMcpCount = snapshot.mcp.filter(
    (client) => client.detected,
  ).length;
  const enabledSourceCount = snapshot.sources.filter(
    (source) => source.enabled,
  ).length;
  const activeTasks = snapshot.recentEvents.filter((event) =>
    activeTaskStatuses.has(event.status),
  );
  const pendingApproval = activeTasks.find(
    (event) => event.status === "awaiting_approval",
  );
  const proposedTask = activeTasks.find((event) => event.status === "proposed");
  const runningTask = activeTasks.find(
    (event) => event.status === "running" || event.status === "queued",
  );
  const blockedTask = activeTasks.find((event) => event.status === "blocked");

  const priority: DashboardPriority = pendingApproval
    ? taskPriority(
        "Review pending approval",
        "A guarded task is paused at the human approval gate.",
        "Open approval gate",
        "awaiting_approval",
      )
    : proposedTask
      ? taskPriority(
          "Review validated plan",
          "A task plan is ready for its local execution approval.",
          "Open task plan",
          "proposed",
        )
      : runningTask
        ? taskPriority(
            "Monitor active task",
            "A local task is currently running with verifier evidence enabled.",
            "Open task console",
            "running",
          )
        : blockedTask
          ? taskPriority(
              "Resolve blocked task",
              "Inspect the policy or configuration reason before retrying.",
              "Inspect task",
              "blocked",
            )
          : snapshot.runtime.runningJobs > 0
            ? {
                title: "Monitor local training",
                detail: `${snapshot.runtime.runningJobs} local training job${snapshot.runtime.runningJobs === 1 ? " is" : "s are"} active.`,
                actionLabel: "Open Game Lab",
                destination: "game",
                status: "running",
              }
            : enabledSourceCount === 0 && fastPathSkillCount === 0
              ? {
                  title: "Prepare the first execution path",
                  detail:
                    "No verified Fast Path Skill or enabled planner is available yet.",
                  actionLabel: "Configure planner",
                  destination: "tasks",
                  status: "blocked",
                }
              : fastPathSkillCount === 0
                ? {
                    title: "Build a reusable Fast Path",
                    detail:
                      "Train a browser Skill locally to add a deterministic route.",
                    actionLabel: "Open Skill Depot",
                    destination: "skills",
                    status: "ready",
                  }
                : {
                    title: "Start a guarded task",
                    detail:
                      "LHIC will try a verified local Skill before any approved Slow Path proposal.",
                    actionLabel: "Open Task Console",
                    destination: "tasks",
                    status: "ready",
                  };

  const readiness: DashboardReadinessItem[] = [
    {
      id: "skills",
      label: "Fast Path",
      detail:
        fastPathSkillCount > 0
          ? `${fastPathSkillCount} verified Skill${fastPathSkillCount === 1 ? "" : "s"} ready.`
          : "No verified Skill yet.",
      state: fastPathSkillCount > 0 ? "ready" : "attention",
      destination: "skills",
    },
    {
      id: "planners",
      label: "Slow Path",
      detail:
        enabledSourceCount > 0
          ? `${enabledSourceCount} planner source${enabledSourceCount === 1 ? "" : "s"} enabled.`
          : "No planner enabled.",
      state: enabledSourceCount > 0 ? "ready" : "attention",
      destination: "tasks",
    },
    {
      id: "library",
      label: "Shared library",
      detail: snapshot.sharedLibrary.enabled
        ? `${snapshot.sharedLibrary.cachedSkillCount} record${snapshot.sharedLibrary.cachedSkillCount === 1 ? "" : "s"} cached.`
        : snapshot.sharedLibrary.configured
          ? "Connection is configured; complete the local sign-in or sync."
          : "Optional registry connection is not active.",
      state: snapshot.sharedLibrary.enabled
        ? "ready"
        : snapshot.sharedLibrary.configured
          ? "attention"
          : "inactive",
      destination: "skills",
    },
    {
      id: "mcp",
      label: "MCP",
      detail:
        detectedMcpCount > 0
          ? `${detectedMcpCount} client${detectedMcpCount === 1 ? "" : "s"} detected.`
          : "No client detected.",
      state: detectedMcpCount > 0 ? "ready" : "inactive",
      destination: "mcp",
    },
  ];

  const attention: DashboardAttentionItem[] = [
    ...activeTasks.slice(0, 2).map((event) => ({
      id: `task-${event.commandId}`,
      title: taskAttentionTitle(event),
      detail: event.message,
      destination: "tasks" as const,
      status: event.status,
    })),
    ...(snapshot.sharedLibrary.lastError
      ? [
          {
            id: "shared-library-error",
            title: "Shared library needs attention",
            detail: snapshot.sharedLibrary.lastError,
            destination: "skills" as const,
            status: "blocked" as const,
          },
        ]
      : []),
    ...(snapshot.sharedLibrary.pendingSubmissionCount > 0
      ? [
          {
            id: "shared-library-pending",
            title: "Skill submission pending review",
            detail: `${snapshot.sharedLibrary.pendingSubmissionCount} local submission${snapshot.sharedLibrary.pendingSubmissionCount === 1 ? " is" : "s are"} waiting for shared-library review.`,
            destination: "skills" as const,
            status: "pending" as const,
          },
        ]
      : []),
  ].slice(0, 3);

  return {
    fastPathSkillCount,
    sharedSkillCount,
    detectedMcpCount,
    enabledSourceCount,
    priority,
    readiness,
    attention,
  };
}

function taskPriority(
  title: string,
  detail: string,
  actionLabel: string,
  status: DashboardPriority["status"],
): DashboardPriority {
  return { title, detail, actionLabel, destination: "tasks", status };
}

function taskAttentionTitle(event: CommandEvent): string {
  switch (event.status) {
    case "awaiting_approval":
      return "Task awaits approval";
    case "proposed":
      return "Task plan awaits execution";
    case "running":
    case "queued":
      return "Task is in progress";
    case "blocked":
      return "Task is blocked";
    default:
      return "Task needs attention";
  }
}
