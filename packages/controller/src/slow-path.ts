import type {
  NormalizedUIState,
  SemanticAction,
  StagePlan,
  TraceEvent,
  UserIntent,
} from "@lhic/schema";
import { isBrowserSemanticAction } from "@lhic/schema";
import { redactPII } from "@lhic/trace";
import type { TaskSummary } from "./task-summary.js";

/** Metadata for a pre-redacted visual observation. Raw image bytes are never traced. */
export interface ModelSafeVisualObservation {
  source: "browser_screenshot";
  mediaType: "image/png" | "image/jpeg";
  byteLength: number;
  redacted: true;
}

export interface SlowPathRequest {
  taskId: string;
  userIntent: UserIntent;
  uiState: NormalizedUIState;
  recentTrace: TraceEvent[];
  reason:
    "low_confidence" | "verification_failed" | "high_risk" | "complex_planning";
  /** Preferred compact context for budgeted planners. */
  taskSummary?: TaskSummary;
  /** Present only when a policy-approved provider supports visual planning. */
  visualObservation?: ModelSafeVisualObservation;
}

export interface SlowPathResponse {
  decision: "ask_user" | "propose_plan" | "retry_with_action" | "blocked";
  message: string;
  proposedActions?: SemanticAction[];
}

export interface SlowPathProvider {
  capabilities?: { visualObservation: boolean };
  reason(request: SlowPathRequest): Promise<SlowPathResponse>;
}

/** Removes typed control values and opaque signals before any model boundary. */
export function toSlowPathSafeUiState(
  state: NormalizedUIState,
): NormalizedUIState {
  const safe = redactPII(state) as NormalizedUIState;
  return {
    ...safe,
    objects: safe.objects.map((object) => {
      const copy = { ...object };
      delete copy.value;
      return copy;
    }),
    signals: {},
  };
}

/** Converts a provider proposal into the controller's executable-stage contract. */
export function toStagePlan(
  response: SlowPathResponse,
  goal: string,
  stage: "plan" | "recover" = "plan",
): StagePlan | undefined {
  const actions = response.proposedActions ?? [];
  if (
    (response.decision !== "propose_plan" &&
      response.decision !== "retry_with_action") ||
    !goal.trim() ||
    actions.length === 0 ||
    !actions.every(isBrowserSemanticAction)
  ) {
    return undefined;
  }
  return {
    schemaVersion: "stage-plan-v1",
    stage,
    goal,
    proposedActions: actions,
    nextStage: "execute",
    summary: response.message,
  };
}
