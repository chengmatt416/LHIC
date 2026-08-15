import type { NormalizedUIState, TraceEvent, UserIntent } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

const maxGoalChars = 2_048;
const maxLocationChars = 2_048;
const maxSummaryItemChars = 512;

export interface TaskSummary {
  goal: string;
  currentLocation?: string;
  completedSteps: string[];
  verifiedEvidence: string[];
  failureReasons: string[];
  nextStage?: string;
}

export function createTaskSummary(input: {
  intent: UserIntent;
  uiState?: NormalizedUIState;
  completedSteps: readonly string[];
  verifiedEvidence: readonly string[];
  failureReasons: readonly string[];
  nextStage?: string;
  recentTrace?: readonly TraceEvent[];
}): TaskSummary {
  const traceEvidence = (input.recentTrace ?? [])
    .filter((event) => event.type === "action_completed")
    .flatMap((event) => {
      const evidence = event.payload.result;
      return evidence && typeof evidence === "object" && "evidence" in evidence
        ? (evidence as { evidence?: unknown }).evidence
        : [];
    })
    .filter((value): value is string => typeof value === "string");

  const redacted = redactPII({
    goal: input.intent.goal,
    ...(input.uiState?.url
      ? { currentLocation: safeLocation(input.uiState.url) }
      : {}),
    completedSteps: [...new Set(input.completedSteps)].slice(-20),
    verifiedEvidence: [
      ...new Set([...input.verifiedEvidence, ...traceEvidence]),
    ].slice(-20),
    failureReasons: [...new Set(input.failureReasons)].slice(-10),
    ...(input.nextStage ? { nextStage: input.nextStage } : {}),
  }) as TaskSummary;
  return {
    ...redacted,
    goal: compactText(redacted.goal, maxGoalChars),
    ...(redacted.currentLocation
      ? {
          currentLocation: compactText(
            redacted.currentLocation,
            maxLocationChars,
          ),
        }
      : {}),
    completedSteps: redacted.completedSteps.map((value) =>
      compactText(value, maxSummaryItemChars),
    ),
    verifiedEvidence: redacted.verifiedEvidence.map((value) =>
      compactText(value, maxSummaryItemChars),
    ),
    failureReasons: redacted.failureReasons.map((value) =>
      compactText(value, maxSummaryItemChars),
    ),
  };
}

function safeLocation(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}

function compactText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}
