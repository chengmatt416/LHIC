import type {
  ControllerStage as TaskStage,
  ExecutionProfile,
  StageRoute,
  UserIntent,
} from "@lhic/schema";

import type { IntentPrediction } from "./predictor.js";
import type { TaskBudgetTracker } from "./task-budget.js";

export interface StageRoutingInput {
  stage: TaskStage;
  profile: ExecutionProfile;
  intent: UserIntent;
  prediction: IntentPrediction;
  hasLocalPlan: boolean;
  budget: TaskBudgetTracker;
  recoveryAttempt?: number;
  failureReason?: string;
  requiresVisualObservation?: boolean;
  visualPlanningAvailable?: boolean;
  shadow?: boolean;
}

/**
 * A deterministic, MoE-like scheduler. It selects one capability path per
 * stage, rather than blending model outputs or allowing providers to choose
 * their own privileges.
 */
export class StageRouter {
  public route(input: StageRoutingInput): StageRoute {
    const stageReservation = input.budget.beginStage();
    if (!stageReservation.allowed) {
      return this.routeResult(
        input,
        "blocked",
        stageReservation.reason,
        stageReservation.remaining,
      );
    }

    if (
      input.intent.riskLevel === "high" ||
      input.intent.riskLevel === "unknown" ||
      input.intent.requiresConfirmation
    ) {
      return this.routeResult(
        input,
        "ask_user",
        "Intent risk requires human confirmation.",
        stageReservation.remaining,
      );
    }

    if (input.requiresVisualObservation) {
      if (
        input.profile === "deliberative" &&
        input.visualPlanningAvailable === true &&
        stageReservation.remaining.maxImageInputs > 0 &&
        stageReservation.remaining.maxSlowPathCalls > 0
      ) {
        return this.routeResult(
          input,
          "slow_vision_planner",
          "No deterministic DOM or accessibility observation is sufficient.",
          stageReservation.remaining,
        );
      }
      return this.routeResult(
        input,
        "blocked",
        "No policy-approved visual planner is available for this observation.",
        stageReservation.remaining,
      );
    }

    if (input.stage === "recover" && (input.recoveryAttempt ?? 0) === 0) {
      return this.routeResult(
        input,
        "local_recovery",
        input.failureReason ??
          "A verified local action failed; refresh local state and retry once.",
        stageReservation.remaining,
        "local_fast",
      );
    }

    if (
      input.stage === "observe" ||
      input.stage === "verify" ||
      (input.hasLocalPlan && input.prediction.confidence >= 0.8)
    ) {
      return this.routeResult(
        input,
        "local_fast",
        "Local observation, verification, or deterministic skill is available.",
        stageReservation.remaining,
      );
    }

    if (input.profile === "fast_only") {
      return this.routeResult(
        input,
        "blocked",
        "fast_only permits no model, MCP, or remote planning fallback.",
        stageReservation.remaining,
      );
    }

    if (stageReservation.remaining.maxSlowPathCalls > 0) {
      return this.routeResult(
        input,
        "slow_planner",
        input.failureReason ??
          "No deterministic low-risk skill meets the confidence threshold.",
        stageReservation.remaining,
        input.stage === "recover" ? "local_recovery" : undefined,
      );
    }

    return this.routeResult(
      input,
      "blocked",
      "The task has no remaining Slow Path budget.",
      stageReservation.remaining,
    );
  }

  private routeResult(
    input: StageRoutingInput,
    path: StageRoute["path"],
    reason: string,
    remainingBudget: StageRoute["remainingBudget"],
    fallbackFrom?: StageRoute["fallbackFrom"],
  ): StageRoute {
    return {
      stage: input.stage,
      path,
      reason,
      confidence: input.prediction.confidence,
      profile: input.profile,
      remainingBudget,
      ...(fallbackFrom ? { fallbackFrom } : {}),
      ...(input.shadow ? { shadow: true } : {}),
    };
  }
}
