import {
  isGlobalComputerAction,
  type SemanticAction,
  type NormalizedUIState,
  type UserIntent,
} from "@lhic/schema";
import { evaluateRisk } from "@lhic/security";

import type { IntentPrediction } from "./predictor.js";
import {
  resolveFastPathPlan,
  type ResolvedFastPathPlan,
} from "./fast-path-plan.js";
import type {
  SlowPathProvider,
  SlowPathRequest,
  SlowPathResponse,
} from "./slow-path.js";
import type {
  SlowPathActionExecutor,
  SlowPathLearningCoordinator,
  SlowPathLearningResult,
} from "./slow-path-learning.js";
import type { SharedSkillResolver } from "./shared-skills.js";

export interface RouteDecision {
  path: "fast" | "slow" | "ask_user" | "blocked";
  reason: string;
  confidence: number;
}

export interface ResolvedRoute {
  decision: RouteDecision;
  plan: ResolvedFastPathPlan;
}

export class FastPathRouter {
  public constructor(
    private readonly slowPathProvider?: SlowPathProvider,
    private readonly slowPathLearningCoordinator?: SlowPathLearningCoordinator,
    private readonly sharedSkillResolver?: SharedSkillResolver,
  ) {}

  /**
   * Resolves the local shared-skill cache before using built-in compilation.
   * The result is self-contained and does not perform network I/O.
   */
  public route(
    prediction: IntentPrediction,
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): ResolvedRoute {
    const plan = resolveFastPathPlan(
      prediction,
      intent,
      uiState,
      this.sharedSkillResolver,
    );
    const routePrediction =
      plan.source === "shared" && plan.skillName
        ? {
            ...prediction,
            skillName: plan.skillName,
            confidence: 0.9,
            evidence: [...prediction.evidence, ...plan.sharedSkill!.evidence],
          }
        : prediction;
    return {
      decision: this.decide(routePrediction, intent, plan.actions),
      plan,
    };
  }

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
      if (isGlobalComputerAction(action)) {
        return {
          path: "ask_user",
          reason:
            "Global desktop actions require an explicit matching human approval.",
          confidence: prediction.confidence,
        };
      }
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

  public async executeSlowPath(
    decision: RouteDecision,
    request: SlowPathRequest,
    executor: SlowPathActionExecutor,
  ): Promise<SlowPathLearningResult | undefined> {
    const response = await this.invokeSlowPath(decision, request);
    if (!response || !this.slowPathLearningCoordinator) {
      return undefined;
    }
    return this.slowPathLearningCoordinator.execute(
      request,
      response,
      executor,
    );
  }
}
