import {
  isGlobalComputerAction,
  type NormalizedUIState,
  type SemanticAction,
  type StageRoute,
  type UserIntent,
} from "@lhic/schema";
import { evaluateRisk } from "@lhic/security";
import { redactPII } from "@lhic/trace";

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
import { toSlowPathSafeUiState } from "./slow-path.js";
import type {
  SlowPathActionExecutor,
  SlowPathLearningCoordinator,
  SlowPathLearningResult,
} from "./slow-path-learning.js";
import type { SharedSkillResolver } from "./shared-skills.js";
import {
  readPathRoutingConfig,
  type PathRoutingConfig,
} from "./path-routing-config.js";
import { StageRouter, type StageRoutingInput } from "./stage-router.js";
import type { TaskBudgetTracker } from "./task-budget.js";

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
  private readonly stageRouter = new StageRouter();

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

  /**
   * Admits a provider call only after the stage route and task budget allow it.
   * This leaves the legacy invokeSlowPath API untouched for existing callers.
   */
  public async invokeRoutedSlowPath(
    route: StageRoute,
    request: SlowPathRequest,
    budget: TaskBudgetTracker,
  ): Promise<SlowPathResponse | undefined> {
    if (
      (route.path !== "slow_planner" && route.path !== "slow_vision_planner") ||
      !this.slowPathProvider
    ) {
      return undefined;
    }
    if (
      route.path === "slow_vision_planner" &&
      this.slowPathProvider.capabilities?.visualObservation !== true
    ) {
      return undefined;
    }
    const redactedRequest = redactPII(request) as SlowPathRequest;
    const safeRequest: SlowPathRequest = {
      ...redactedRequest,
      uiState: toSlowPathSafeUiState(redactedRequest.uiState),
    };
    const inputChars = JSON.stringify(safeRequest).length;
    const reservation = budget.reserveSlowPath(
      inputChars,
      route.path === "slow_vision_planner" ? 1 : 0,
    );
    if (!reservation.allowed) {
      return undefined;
    }
    const startedAt = performance.now();
    try {
      return await this.slowPathProvider.reason({
        ...safeRequest,
        // A compact summary is authoritative for new orchestrated requests.
        recentTrace: safeRequest.taskSummary ? [] : safeRequest.recentTrace,
      });
    } finally {
      budget.recordSlowPathLatency(performance.now() - startedAt);
    }
  }

  /** Routes an individual controller stage without changing the legacy facade. */
  public routeStage(input: StageRoutingInput): StageRoute {
    return this.stageRouter.route({
      ...input,
      ...(input.visualPlanningAvailable === undefined
        ? {
            visualPlanningAvailable:
              this.slowPathProvider?.capabilities?.visualObservation === true,
          }
        : {}),
    });
  }

  /**
   * Applies the deployment flag without changing the legacy router contract.
   * Shadow routes are evidence-only; callers must continue legacy execution.
   */
  public routeConfiguredStage(
    input: Omit<StageRoutingInput, "profile" | "shadow"> & {
      profile?: StageRoutingInput["profile"];
    },
    config: PathRoutingConfig = readPathRoutingConfig(),
  ): StageRoute | undefined {
    if (config.mode === "legacy") {
      return undefined;
    }
    return this.routeStage({
      ...input,
      profile: input.profile ?? config.defaultProfile,
      shadow: config.mode === "shadow",
    });
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
