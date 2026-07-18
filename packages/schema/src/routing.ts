import {
  isBrowserSemanticAction,
  type BrowserSemanticAction,
} from "./action.js";

/**
 * Execution profiles bound the cost and capabilities available to a task. A
 * controller may choose a less capable path, but never escalate a task beyond
 * its selected profile.
 */
export const executionProfiles = [
  "fast_only",
  "balanced",
  "deliberative",
] as const;

export type ExecutionProfile = (typeof executionProfiles)[number];

export const controllerStages = [
  "observe",
  "interpret",
  "plan",
  "execute",
  "verify",
  "recover",
] as const;

export type ControllerStage = (typeof controllerStages)[number];

export const expertPaths = [
  "local_fast",
  "local_recovery",
  "slow_planner",
  "slow_vision_planner",
  "ask_user",
  "blocked",
] as const;

export type ExpertPath = (typeof expertPaths)[number];

export interface TaskBudget {
  maxSlowPathCalls: number;
  maxSlowPathInputChars: number;
  maxImageInputs: number;
  maxStages: number;
  maxWallClockMs: number;
}

export interface TaskBudgetUsage {
  slowPathCalls: number;
  slowPathInputChars: number;
  imageInputs: number;
  slowPathLatencyMs: number;
  stages: number;
  wallClockMs: number;
}

export interface StageRoute {
  stage: ControllerStage;
  path: ExpertPath;
  reason: string;
  confidence: number;
  profile: ExecutionProfile;
  remainingBudget: TaskBudget;
  fallbackFrom?: ExpertPath;
  shadow?: boolean;
}

/** A provider proposal that must still pass LHIC execution and verification. */
export interface StagePlan {
  schemaVersion: "stage-plan-v1";
  stage: Extract<ControllerStage, "plan" | "recover">;
  goal: string;
  proposedActions: BrowserSemanticAction[];
  nextStage: Extract<ControllerStage, "execute" | "verify">;
  summary?: string;
}

export const defaultTaskBudgets: Readonly<
  Record<ExecutionProfile, TaskBudget>
> = {
  fast_only: {
    maxSlowPathCalls: 0,
    maxSlowPathInputChars: 0,
    maxImageInputs: 0,
    maxStages: 12,
    maxWallClockMs: 30_000,
  },
  balanced: {
    maxSlowPathCalls: 1,
    maxSlowPathInputChars: 12_000,
    maxImageInputs: 0,
    maxStages: 20,
    maxWallClockMs: 60_000,
  },
  deliberative: {
    maxSlowPathCalls: 3,
    maxSlowPathInputChars: 24_000,
    maxImageInputs: 1,
    maxStages: 32,
    maxWallClockMs: 120_000,
  },
};

export function isExecutionProfile(value: unknown): value is ExecutionProfile {
  return (
    typeof value === "string" &&
    (executionProfiles as readonly string[]).includes(value)
  );
}

export function isControllerStage(value: unknown): value is ControllerStage {
  return (
    typeof value === "string" &&
    (controllerStages as readonly string[]).includes(value)
  );
}

export function isExpertPath(value: unknown): value is ExpertPath {
  return (
    typeof value === "string" &&
    (expertPaths as readonly string[]).includes(value)
  );
}

export function isTaskBudget(value: unknown): value is TaskBudget {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<TaskBudget>;
  return [
    candidate.maxSlowPathCalls,
    candidate.maxSlowPathInputChars,
    candidate.maxImageInputs,
    candidate.maxStages,
    candidate.maxWallClockMs,
  ].every(
    (limit) =>
      typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 0,
  );
}

export function isStagePlan(value: unknown): value is StagePlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<StagePlan>;
  return (
    candidate.schemaVersion === "stage-plan-v1" &&
    (candidate.stage === "plan" || candidate.stage === "recover") &&
    typeof candidate.goal === "string" &&
    candidate.goal.trim().length > 0 &&
    Array.isArray(candidate.proposedActions) &&
    candidate.proposedActions.every(isBrowserSemanticAction) &&
    candidate.nextStage !== undefined &&
    ["execute", "verify"].includes(candidate.nextStage) &&
    (candidate.summary === undefined || typeof candidate.summary === "string")
  );
}
