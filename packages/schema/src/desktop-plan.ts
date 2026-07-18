import { isGlobalComputerAction, type GlobalComputerAction } from "./action.js";

export interface DesktopPlanVariable {
  name: string;
  prompt: string;
}

/**
 * A local desktop program emitted by a Slow Path planner. Each step is an
 * existing global-computer action, which carries a mandatory observable
 * verifier. These plans are never eligible for the browser Fast Path.
 */
export interface DesktopExecutionPlan {
  schemaVersion: "desktop-plan-v1";
  goal: string;
  skillName?: string;
  requiredVariables: DesktopPlanVariable[];
  steps: Array<{
    id: string;
    action: GlobalComputerAction;
  }>;
}

export function isDesktopExecutionPlan(
  value: unknown,
): value is DesktopExecutionPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<DesktopExecutionPlan>;
  if (
    candidate.schemaVersion !== "desktop-plan-v1" ||
    typeof candidate.goal !== "string" ||
    candidate.goal.trim().length === 0 ||
    (candidate.skillName !== undefined &&
      (typeof candidate.skillName !== "string" ||
        candidate.skillName.trim().length === 0)) ||
    !Array.isArray(candidate.requiredVariables) ||
    !Array.isArray(candidate.steps) ||
    candidate.steps.length === 0
  ) {
    return false;
  }

  const ids = new Set<string>();
  for (const step of candidate.steps) {
    if (
      !step ||
      typeof step !== "object" ||
      typeof step.id !== "string" ||
      !step.id.trim() ||
      ids.has(step.id) ||
      !isGlobalComputerAction(step.action)
    ) {
      return false;
    }
    ids.add(step.id);
  }
  return candidate.requiredVariables.every(isDesktopPlanVariable);
}

function isDesktopPlanVariable(value: unknown): value is DesktopPlanVariable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<DesktopPlanVariable>;
  return (
    typeof candidate.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate.name) &&
    typeof candidate.prompt === "string" &&
    candidate.prompt.trim().length > 0
  );
}
