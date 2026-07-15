import { isRiskLevel, type RiskLevel } from "./risk.js";

export const semanticActionTypes = [
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "download",
  "custom",
] as const;

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

export interface SemanticAction {
  type: SemanticActionType;
  intent: string;
  target?: string;
  value?: unknown;
  methodPreference: ActionMethod[];
  riskLevel: RiskLevel;
}

export interface ActionExecutionResult {
  success: boolean;
  method?: ActionMethod;
  latencyMs: number;
  evidence: string[];
  error?: string;
}

export function isSemanticAction(value: unknown): value is SemanticAction {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SemanticAction>;
  return (
    typeof candidate.type === "string" &&
    (semanticActionTypes as readonly string[]).includes(candidate.type) &&
    typeof candidate.intent === "string" &&
    candidate.intent.trim().length > 0 &&
    (candidate.target === undefined || typeof candidate.target === "string") &&
    Array.isArray(candidate.methodPreference) &&
    candidate.methodPreference.length > 0 &&
    candidate.methodPreference.every(
      (method) =>
        typeof method === "string" &&
        (actionMethods as readonly string[]).includes(method),
    ) &&
    isRiskLevel(candidate.riskLevel)
  );
}
