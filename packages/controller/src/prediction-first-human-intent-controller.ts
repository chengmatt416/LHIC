import type { NormalizedUIState, UserIntent } from "@lhic/schema";

import {
  FastPathRouter,
  type ResolvedRoute,
  type RouteDecision,
} from "./fast-path-router.js";
import {
  HumanIntentLearnLoop,
  type HumanIntentDecision,
} from "./human-intent-learnloop.js";
import { predictIntent } from "./predictor.js";
import { classifyStage } from "./stage-classifier.js";

export interface PredictionFirstRouteResult {
  humanIntent: HumanIntentDecision;
  route: ResolvedRoute;
}

/**
 * Public prediction-first facade for XTF experiments and future runtime wiring.
 * The existing predictor always runs first. LearnLoop may add a stricter gate,
 * while FastPathRouter remains authoritative for plans, risk, and execution.
 */
export class PredictionFirstHumanIntentController {
  public constructor(
    private readonly router: FastPathRouter,
    private readonly learnLoop?: HumanIntentLearnLoop,
  ) {}

  public route(
    sessionId: string,
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): PredictionFirstRouteResult {
    const humanIntent = this.learnLoop
      ? this.learnLoop.decide(sessionId, intent, uiState)
      : baselineHumanIntentDecision(intent, uiState);
    const resolved = this.router.route(
      humanIntent.prediction,
      intent,
      uiState,
    );
    return {
      humanIntent,
      route: {
        ...resolved,
        decision: applyHumanIntentGate(resolved.decision, humanIntent),
      },
    };
  }
}

function baselineHumanIntentDecision(
  intent: UserIntent,
  uiState: NormalizedUIState,
): HumanIntentDecision {
  const startedAt = performance.now();
  const prediction = predictIntent(intent, uiState);
  const classification = classifyStage(intent, uiState);
  const riskRequiresConfirmation =
    intent.riskLevel === "high" ||
    intent.riskLevel === "unknown" ||
    intent.requiresConfirmation;
  const admission = riskRequiresConfirmation
    ? "require_confirmation"
    : prediction.skillName && prediction.confidence >= 0.8
      ? "execute_fast"
      : "defer_to_slow_path";
  return {
    admission,
    reason: riskRequiresConfirmation
      ? "Risk policy requires confirmation before routing."
      : admission === "execute_fast"
        ? "Base human-intent prediction is eligible for Fast Path evaluation."
        : "Base human-intent prediction requires Slow Path evaluation.",
    basePrediction: prediction,
    prediction,
    classificationCandidates: [...classification.candidates],
    drift: { detected: false, score: 0, reasons: [] },
    appliedRuleIds: [],
    decisionLatencyMs: performance.now() - startedAt,
  };
}

function applyHumanIntentGate(
  routerDecision: RouteDecision,
  humanIntent: HumanIntentDecision,
): RouteDecision {
  if (
    routerDecision.path === "blocked" ||
    routerDecision.path === "ask_user"
  ) {
    return routerDecision;
  }
  if (humanIntent.admission === "require_confirmation") {
    return {
      path: "ask_user",
      reason: humanIntent.reason,
      confidence: humanIntent.prediction.confidence,
    };
  }
  if (humanIntent.admission === "defer_to_slow_path") {
    return {
      path: "slow",
      reason: humanIntent.reason,
      confidence: humanIntent.prediction.confidence,
    };
  }
  return routerDecision;
}
