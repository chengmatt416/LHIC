import type { SemanticAction, UserIntent } from "@lhic/schema";
import { evaluateRisk } from "@lhic/security";

import type { IntentPrediction } from "./predictor.js";
import type {
  SlowPathProvider,
  SlowPathRequest,
  SlowPathResponse,
} from "./slow-path.js";

export interface RouteDecision {
  path: "fast" | "slow" | "ask_user" | "blocked";
  reason: string;
  confidence: number;
}

export class FastPathRouter {
  public constructor(private readonly slowPathProvider?: SlowPathProvider) {}

  public decide(
    prediction: IntentPrediction,
    intent: UserIntent,
    actions: SemanticAction[] = [],
  ): RouteDecision {
    if (
      intent.riskLevel === "high" ||
      intent.riskLevel === "unknown" ||
      intent.requiresConfirmation
    ) {
      return {
        path: "ask_user",
        reason: "Intent risk requires human confirmation.",
        confidence: prediction.confidence,
      };
    }
    if (intent.riskLevel !== "low") {
      return {
        path: "slow",
        reason: "Only low-risk intents are eligible for Fast Path.",
        confidence: prediction.confidence,
      };
    }
    for (const action of actions) {
      const policy = evaluateRisk(action);
      if (policy.requiresConfirmation) {
        return {
          path: "ask_user",
          reason: policy.reason,
          confidence: prediction.confidence,
        };
      }
      if (action.riskLevel !== "low") {
        return {
          path: "slow",
          reason: "Only low-risk actions are eligible for Fast Path.",
          confidence: prediction.confidence,
        };
      }
    }
    if (prediction.confidence < 0.8) {
      return {
        path: "slow",
        reason: "Local prediction confidence is below the Fast Path threshold.",
        confidence: prediction.confidence,
      };
    }
    if (!prediction.skillName) {
      return {
        path: "blocked",
        reason: "No deterministic skill is available for the predicted intent.",
        confidence: prediction.confidence,
      };
    }
    return {
      path: "fast",
      reason: "Low-risk skill is clear and meets the confidence threshold.",
      confidence: prediction.confidence,
    };
  }

  public async invokeSlowPath(
    decision: RouteDecision,
    request: SlowPathRequest,
  ): Promise<SlowPathResponse | undefined> {
    if (decision.path !== "slow" || !this.slowPathProvider) {
      return undefined;
    }
    return this.slowPathProvider.reason(request);
  }
}
