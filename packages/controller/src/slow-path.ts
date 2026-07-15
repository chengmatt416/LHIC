import type {
  NormalizedUIState,
  SemanticAction,
  TraceEvent,
  UserIntent,
} from "@lhic/schema";

export interface SlowPathRequest {
  taskId: string;
  userIntent: UserIntent;
  uiState: NormalizedUIState;
  recentTrace: TraceEvent[];
  reason:
    "low_confidence" | "verification_failed" | "high_risk" | "complex_planning";
}

export interface SlowPathResponse {
  decision: "ask_user" | "propose_plan" | "retry_with_action" | "blocked";
  message: string;
  proposedActions?: SemanticAction[];
}

export interface SlowPathProvider {
  reason(request: SlowPathRequest): Promise<SlowPathResponse>;
}
