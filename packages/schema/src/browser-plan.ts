import {
  isBrowserSemanticAction,
  type BrowserSemanticAction,
} from "./action.js";
import {
  isVerificationCondition,
  type VerificationCondition,
} from "./verifier.js";

/**
 * A single browser operation emitted by a planner. The verifier is deliberately
 * part of the wire contract so an executor never has to infer success from an
 * input event alone.
 */
export interface PlannedBrowserStep {
  id: string;
  action: BrowserSemanticAction;
  verification: VerificationCondition;
}

export interface BrowserPlanVariable {
  name: string;
  prompt: string;
}

/** A complete, model-independent browser program that LHIC can execute. */
export interface BrowserExecutionPlan {
  schemaVersion: "browser-plan-v1";
  goal: string;
  skillName?: string;
  requiredVariables: BrowserPlanVariable[];
  steps: PlannedBrowserStep[];
}

const executableActionTypes = new Set<BrowserSemanticAction["type"]>([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "download",
]);

export function isPlannedBrowserStep(
  value: unknown,
): value is PlannedBrowserStep {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PlannedBrowserStep>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.trim().length > 0 &&
    isBrowserSemanticAction(candidate.action) &&
    executableActionTypes.has(candidate.action.type) &&
    isExecutableAction(candidate.action) &&
    isVerificationCondition(candidate.verification)
  );
}

export function isBrowserExecutionPlan(
  value: unknown,
): value is BrowserExecutionPlan {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BrowserExecutionPlan>;
  if (
    candidate.schemaVersion !== "browser-plan-v1" ||
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
    if (!isPlannedBrowserStep(step) || ids.has(step.id)) {
      return false;
    }
    ids.add(step.id);
  }
  return candidate.requiredVariables.every(isBrowserPlanVariable);
}

function isBrowserPlanVariable(value: unknown): value is BrowserPlanVariable {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BrowserPlanVariable>;
  return (
    typeof candidate.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_-]*$/.test(candidate.name) &&
    typeof candidate.prompt === "string" &&
    candidate.prompt.trim().length > 0
  );
}

function isExecutableAction(action: BrowserSemanticAction): boolean {
  switch (action.type) {
    case "navigate":
    case "click":
    case "download":
      return (
        typeof action.target === "string" && action.target.trim().length > 0
      );
    case "fill":
    case "select":
      return (
        typeof action.target === "string" &&
        action.target.trim().length > 0 &&
        typeof action.value === "string"
      );
    case "press":
      return action.value === undefined || typeof action.value === "string";
    case "wait":
      return action.value === undefined || typeof action.value === "number";
    case "custom":
      return false;
  }
}
