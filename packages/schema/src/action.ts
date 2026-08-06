import { isRiskLevel, type RiskLevel } from "./risk.js";

export const browserSemanticActionTypes = [
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "download",
  "custom",
] as const;

export const globalComputerActionTypes = [
  "os_click",
  "os_type",
  "os_press",
  "os_launch",
  "os_focus",
  "os_screenshot",
  "os_observe",
  "os_scroll",
  "os_clipboard",
] as const;

export const semanticActionTypes = [
  ...browserSemanticActionTypes,
  ...globalComputerActionTypes,
] as const;

export type BrowserSemanticActionType =
  (typeof browserSemanticActionTypes)[number];
export type GlobalComputerActionType =
  (typeof globalComputerActionTypes)[number];
export type SemanticActionType = (typeof semanticActionTypes)[number];

export type ActionMethod =
  "api" | "dom" | "accessibility" | "keyboard" | "ocr" | "vision" | "mouse";

export const actionMethods: readonly ActionMethod[] = [
  "api",
  "dom",
  "accessibility",
  "keyboard",
  "ocr",
  "vision",
  "mouse",
];

export interface BrowserSemanticAction {
  scope?: "browser";
  type: BrowserSemanticActionType;
  intent: string;
  target?: string;
  value?: unknown;
  methodPreference: ActionMethod[];
  riskLevel: RiskLevel;
}

export const globalVerificationTypes = [
  "active_window",
  "process_running",
] as const;

export type GlobalVerificationType = (typeof globalVerificationTypes)[number];

/**
 * Global actions are only successful when an observable desktop condition is
 * checked after input is dispatched. This intentionally avoids claiming that a
 * raw click or keystroke, by itself, verified application state.
 */
export interface ActiveWindowVerification {
  type: "active_window";
  application?: string;
  title?: string;
}

export interface ProcessRunningVerification {
  type: "process_running";
  application: string;
}

export type GlobalComputerVerification =
  ActiveWindowVerification | ProcessRunningVerification;

export interface GlobalComputerAction {
  scope: "os";
  type: GlobalComputerActionType;
  intent: string;
  /** A human-readable target retained in the approval hash and trace metadata. */
  target?: string;
  methodPreference: ActionMethod[];
  riskLevel: RiskLevel;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  application?: string;
  verifier: GlobalComputerVerification;
  /** Screenshot output path (os_screenshot). */
  outputPath?: string;
  /** Scroll direction and amount (os_scroll). */
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  /** Clipboard operation (os_clipboard). */
  clipboardAction?: "copy" | "paste" | "read";
  /** Observe scope (os_observe). */
  observeScope?: "active_window" | "all_windows" | "application";
}

export type SemanticAction = BrowserSemanticAction | GlobalComputerAction;

export interface ActionExecutionResult {
  success: boolean;
  method?: ActionMethod;
  latencyMs: number;
  evidence: string[];
  error?: string;
}

export function isActionMethod(value: unknown): value is ActionMethod {
  return (
    typeof value === "string" &&
    (actionMethods as readonly string[]).includes(value)
  );
}

export function isBrowserSemanticAction(
  value: unknown,
): value is BrowserSemanticAction {
  if (!hasCommonActionFields(value)) {
    return false;
  }

  const candidate = value as Partial<BrowserSemanticAction>;
  return (
    (candidate.scope === undefined || candidate.scope === "browser") &&
    typeof candidate.type === "string" &&
    (browserSemanticActionTypes as readonly string[]).includes(
      candidate.type,
    ) &&
    (candidate.target === undefined || typeof candidate.target === "string")
  );
}

export function isGlobalComputerAction(
  value: unknown,
): value is GlobalComputerAction {
  if (!hasCommonActionFields(value)) {
    return false;
  }

  const candidate = value as Partial<GlobalComputerAction>;
  if (
    candidate.scope !== "os" ||
    typeof candidate.type !== "string" ||
    !(globalComputerActionTypes as readonly string[]).includes(
      candidate.type,
    ) ||
    !isGlobalComputerVerification(candidate.verifier) ||
    (candidate.target !== undefined && typeof candidate.target !== "string") ||
    (candidate.application !== undefined &&
      (typeof candidate.application !== "string" ||
        candidate.application.trim().length === 0)) ||
    (candidate.text !== undefined && typeof candidate.text !== "string") ||
    (candidate.key !== undefined &&
      (typeof candidate.key !== "string" ||
        candidate.key.trim().length === 0)) ||
    (candidate.x !== undefined && !isFiniteCoordinate(candidate.x)) ||
    (candidate.y !== undefined && !isFiniteCoordinate(candidate.y))
  ) {
    return false;
  }

  switch (candidate.type) {
    case "os_click":
      return isFiniteCoordinate(candidate.x) && isFiniteCoordinate(candidate.y);
    case "os_type":
      return typeof candidate.text === "string";
    case "os_press":
      return (
        typeof candidate.key === "string" && candidate.key.trim().length > 0
      );
    case "os_launch":
    case "os_focus":
      return (
        typeof candidate.application === "string" &&
        candidate.application.trim().length > 0
      );
    case "os_screenshot":
    case "os_observe":
    case "os_scroll":
    case "os_clipboard":
      return true;
    default:
      return false;
  }
}

export function isSemanticAction(value: unknown): value is SemanticAction {
  return isBrowserSemanticAction(value) || isGlobalComputerAction(value);
}

function hasCommonActionFields(
  value: unknown,
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SemanticAction>;
  return (
    typeof candidate.intent === "string" &&
    candidate.intent.trim().length > 0 &&
    Array.isArray(candidate.methodPreference) &&
    candidate.methodPreference.length > 0 &&
    candidate.methodPreference.every(isActionMethod) &&
    isRiskLevel(candidate.riskLevel)
  );
}

function isGlobalComputerVerification(
  value: unknown,
): value is GlobalComputerVerification {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<GlobalComputerVerification>;
  if (candidate.type === "active_window") {
    return (
      (candidate.application === undefined ||
        (typeof candidate.application === "string" &&
          candidate.application.trim().length > 0)) &&
      (candidate.title === undefined ||
        (typeof candidate.title === "string" &&
          candidate.title.trim().length > 0))
    );
  }
  return (
    candidate.type === "process_running" &&
    typeof candidate.application === "string" &&
    candidate.application.trim().length > 0
  );
}

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
