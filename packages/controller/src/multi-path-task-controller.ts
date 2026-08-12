import {
  type ActionExecutionResult,
  type ExecutionProfile,
  type NormalizedUIState,
  type SemanticAction,
  type StageRoute,
  type TaskBudget,
  type TaskBudgetUsage,
  type UserIntent,
  type VerificationResult,
} from "@lhic/schema";
import { actionRequiresApproval } from "@lhic/security";
import { appendStageRouteEvent } from "@lhic/trace";

import {
  OperationInterruptedError,
  runInterruptible,
} from "./interruptible-operation.js";
import { ContextEngine } from "./context-engine.js";
import { FastPathRouter } from "./fast-path-router.js";
import type { PathRoutingConfig } from "./path-routing-config.js";
import type { IntentPrediction } from "./predictor.js";
import {
  toStagePlan,
  type SlowPathRequest,
  type SlowPathResponse,
} from "./slow-path.js";
import type { SlowPathActionExecutor } from "./slow-path-learning.js";
import type { StageRoutingInput } from "./stage-router.js";
import {
  TaskBudgetTracker,
  type TaskBudgetTrackerOptions,
} from "./task-budget.js";
import type { TaskSummaryPersistence } from "./task-summary-store.js";

export interface MultiPathTaskControllerOptions {
  taskId: string;
  intent: UserIntent;
  prediction: IntentPrediction;
  profile: ExecutionProfile;
  /** A new observation is required before the one allowed local recovery. */
  observe(signal?: AbortSignal): Promise<NormalizedUIState>;
  /** Resolves only deterministic built-in or already-promoted shared skills. */
  resolveLocalPlan(
    state: NormalizedUIState,
    signal?: AbortSignal,
  ): Promise<readonly SemanticAction[] | undefined>;
  /**
   * This boundary must execute through LHIC's local policy, approval, and
   * verifier stack. A planner never receives a browser or desktop handle.
   */
  executor: SlowPathActionExecutor;
  router?: FastPathRouter;
  config?: PathRoutingConfig;
  budget?: TaskBudgetTrackerOptions;
  /** Cancels the current interruptible stage without replaying physical actions. */
  signal?: AbortSignal;
  traceFilePath?: string;
  summaryStore?: TaskSummaryPersistence;
}

export interface MultiPathTaskResult {
  status: "completed" | "ask_user" | "blocked" | "failed";
  routes: StageRoute[];
  outcomes: MultiPathActionOutcome[];
  budget: TaskBudgetUsage;
  remainingBudget: TaskBudget;
  summary: ReturnType<ContextEngine["summarize"]>;
  failureReason?: string;
}

export interface MultiPathActionOutcome {
  action: SemanticAction;
  execution: ActionExecutionResult;
  verification: VerificationResult;
}

/**
 * Executes a task as separately-routed controller stages. It preserves the
 * old router facade, supports shadow evidence, and keeps every physical action
 * behind the existing local executor and verifier boundary.
 */
export class MultiPathTaskController {
  private readonly router: FastPathRouter;
  private readonly budget: TaskBudgetTracker;
  private readonly context: ContextEngine;
  private readonly routes: StageRoute[] = [];
  private readonly outcomes: MultiPathActionOutcome[] = [];

  public constructor(private readonly options: MultiPathTaskControllerOptions) {
    this.router = options.router ?? new FastPathRouter();
    this.budget = new TaskBudgetTracker(options.profile, options.budget);
    this.context = new ContextEngine(options.taskId, options.intent.goal);
  }

  public async run(): Promise<MultiPathTaskResult> {
    try {
      return await this.runTask();
    } catch (error) {
      const failureReason =
        error instanceof Error && error.message.trim()
          ? `Controller operation failed: ${error.message.trim()}`
          : "Controller operation failed.";
      this.context.recordFailure(failureReason);
      return this.result("failed", failureReason, false);
    }
  }

  private async runTask(): Promise<MultiPathTaskResult> {
    const initialObservation = await this.route("observe", undefined, 0);
    if (initialObservation.path !== "local_fast") {
      return this.result(
        initialObservation.path === "ask_user" ? "ask_user" : "blocked",
        initialObservation.path === "blocked"
          ? initialObservation.reason
          : undefined,
      );
    }
    let state = await this.observe();
    let localPlan = await this.resolveLocalPlan(state);

    const initial = await this.runPlanStage(state, localPlan, 0);
    if (!initial) return this.result("completed");
    if (initial.status !== "failed") {
      return this.result(initial.status, initial.failureReason);
    }

    const recovery = await this.route("recover", localPlan, 0);
    if (recovery.path === "ask_user" || recovery.path === "blocked") {
      return this.result(
        recovery.path,
        recovery.path === "blocked" ? recovery.reason : undefined,
      );
    }

    if (recovery.path === "local_recovery") {
      const recoveryObservation = await this.route("observe", undefined, 1);
      if (recoveryObservation.path !== "local_fast") {
        return this.result(
          recoveryObservation.path === "ask_user" ? "ask_user" : "blocked",
          recoveryObservation.path === "blocked"
            ? recoveryObservation.reason
            : undefined,
        );
      }
      state = await this.observe();
      localPlan = await this.resolveLocalPlan(state);
      const retried = await this.runPlanStage(state, localPlan, 1);
      if (!retried) return this.result("completed");
      if (retried.status !== "failed") {
        return this.result(retried.status, retried.failureReason);
      }
      const fallback = await this.route("recover", localPlan, 1);
      if (fallback.path === "slow_planner") {
        const refreshed = await this.observeForRecovery(1);
        if ("status" in refreshed) {
          return this.result(refreshed.status, refreshed.failureReason);
        }
        const slow = await this.runSlowPlan(
          refreshed.state,
          "recover",
          fallback,
        );
        if (!slow) return this.result("completed");
        return this.result(slow.status, slow.failureReason);
      }
      return this.result(
        fallback.path === "ask_user" ? "ask_user" : "blocked",
        fallback.path === "blocked" ? fallback.reason : undefined,
      );
    } else if (recovery.path === "slow_planner") {
      const refreshed = await this.observeForRecovery(0);
      if ("status" in refreshed) {
        return this.result(refreshed.status, refreshed.failureReason);
      }
      const slow = await this.runSlowPlan(refreshed.state, "recover", recovery);
      if (!slow) return this.result("completed");
      return this.result(slow.status, slow.failureReason);
    }

    return this.result("blocked", "No verified execution path remained.");
  }

  private async observe(): Promise<NormalizedUIState> {
    const state = await this.runInterruptible("observe", (signal) =>
      this.options.observe(signal),
    );
    this.context.setStage("observe");
    this.context.setUIState(state);
    this.context.completeStep("observe");
    return state;
  }

  private async observeForRecovery(
    recoveryAttempt: number,
  ): Promise<
    | { state: NormalizedUIState }
    | { status: "ask_user" | "blocked"; failureReason?: string }
  > {
    const observationRoute = await this.route(
      "observe",
      undefined,
      recoveryAttempt,
    );
    if (observationRoute.path !== "local_fast") {
      return {
        status: observationRoute.path === "ask_user" ? "ask_user" : "blocked",
        ...(observationRoute.path === "blocked"
          ? { failureReason: observationRoute.reason }
          : {}),
      };
    }
    return { state: await this.observe() };
  }

  private async runPlanStage(
    state: NormalizedUIState,
    localPlan: readonly SemanticAction[] | undefined,
    recoveryAttempt: number,
  ): Promise<
    | { status: "ask_user" | "blocked" | "failed"; failureReason?: string }
    | undefined
  > {
    const interpret = await this.route("interpret", localPlan, recoveryAttempt);
    if (interpret.path === "ask_user" || interpret.path === "blocked") {
      return {
        status: interpret.path,
        ...(interpret.path === "blocked"
          ? { failureReason: interpret.reason }
          : {}),
      };
    }

    const planRoute = await this.route("plan", localPlan, recoveryAttempt);
    if (planRoute.path === "ask_user" || planRoute.path === "blocked") {
      return {
        status: planRoute.path,
        ...(planRoute.path === "blocked"
          ? { failureReason: planRoute.reason }
          : {}),
      };
    }
    if (planRoute.path === "local_fast") {
      if (!localPlan?.length) {
        return {
          status: "blocked",
          failureReason: "No local plan was available.",
        };
      }
      return this.executePlan(localPlan, recoveryAttempt);
    }
    if (
      planRoute.path === "slow_planner" ||
      planRoute.path === "slow_vision_planner"
    ) {
      return this.runSlowPlan(state, "plan", planRoute);
    }
    return { status: "blocked", failureReason: planRoute.reason };
  }

  private async runSlowPlan(
    state: NormalizedUIState,
    stage: "plan" | "recover",
    route: StageRoute,
  ): Promise<
    | { status: "ask_user" | "blocked" | "failed"; failureReason?: string }
    | undefined
  > {
    if (route.path !== "slow_planner" && route.path !== "slow_vision_planner") {
      return { status: "blocked", failureReason: "Slow Path was not routed." };
    }
    const request: SlowPathRequest = {
      taskId: this.options.taskId,
      userIntent: this.options.intent,
      uiState: state,
      recentTrace: [],
      taskSummary: this.context.summarize(this.options.intent, stage),
      reason: stage === "recover" ? "verification_failed" : "low_confidence",
    };
    let response: SlowPathResponse | undefined;
    try {
      response = await this.runInterruptible("Slow Path planning", (signal) =>
        this.router.invokeRoutedSlowPath(route, request, this.budget, signal),
      );
    } catch (error) {
      const failureReason =
        error instanceof OperationInterruptedError
          ? `The budgeted planner was unavailable: ${error.message}`
          : "The budgeted planner was unavailable.";
      this.context.recordFailure(failureReason);
      return { status: "blocked", failureReason };
    }
    if (!response) {
      return {
        status: "blocked",
        failureReason: "Slow Path call was not admitted.",
      };
    }
    if (response.decision === "ask_user") {
      return {
        status: "ask_user",
        ...(response.message.trim()
          ? { failureReason: response.message.trim() }
          : {}),
      };
    }
    if (response.decision === "blocked") {
      const failureReason =
        response.message.trim() || "The Slow Path provider blocked the task.";
      this.context.recordFailure(failureReason);
      return { status: "blocked", failureReason };
    }
    const stagePlan = toStagePlan(response, this.options.intent.goal, stage);
    if (!stagePlan) {
      return {
        status: "blocked",
        failureReason: "Slow Path did not return a valid executable StagePlan.",
      };
    }
    return this.executePlan(
      stagePlan.proposedActions,
      stage === "recover" ? 1 : 0,
    );
  }

  private async executePlan(
    actions: readonly SemanticAction[],
    recoveryAttempt: number,
  ): Promise<
    | { status: "ask_user" | "blocked" | "failed"; failureReason?: string }
    | undefined
  > {
    const executeRoute = await this.route("execute", actions, recoveryAttempt);
    if (executeRoute.path === "ask_user" || executeRoute.path === "blocked") {
      return {
        status: executeRoute.path,
        ...(executeRoute.path === "blocked"
          ? { failureReason: executeRoute.reason }
          : {}),
      };
    }

    for (const action of actions) {
      const approvalReason = actionRequiresApproval(action);
      if (approvalReason) {
        return { status: "ask_user", failureReason: approvalReason };
      }
      const outcome = await this.runInterruptible(
        `execute ${action.type}`,
        (signal) => this.options.executor.execute(action, signal),
      );
      this.outcomes.push({ action, ...outcome });
      if (
        !outcome.execution.success ||
        !outcome.verification.success ||
        outcome.verification.evidence.length === 0
      ) {
        const failureReason =
          outcome.execution.error ??
          outcome.verification.error ??
          "A local verifier did not produce evidence.";
        this.context.recordFailure(failureReason);
        return { status: "failed", failureReason };
      }
      try {
        this.options.executor.rememberVerifiedAction?.(
          action,
          outcome.verification,
        );
      } catch {
        // Optional learning must not turn a verified physical action into a retry.
      }
      this.context.recordVerification(outcome.verification.evidence);
      this.context.completeStep(action.intent);
    }

    const verifyRoute = await this.route("verify", actions, recoveryAttempt);
    if (verifyRoute.path !== "local_fast") {
      return {
        status: verifyRoute.path === "ask_user" ? "ask_user" : "blocked",
        ...(verifyRoute.path === "blocked"
          ? { failureReason: verifyRoute.reason }
          : {}),
      };
    }
    this.context.setStage("verify");
    return undefined;
  }

  private async resolveLocalPlan(
    state: NormalizedUIState,
  ): Promise<readonly SemanticAction[] | undefined> {
    return this.runInterruptible("local planning", (signal) =>
      this.options.resolveLocalPlan(state, signal),
    );
  }

  private async runInterruptible<T>(
    operation: string,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const reservation = this.budget.snapshot();
    const timeoutMs = reservation.remaining.maxWallClockMs;
    if (!reservation.allowed || timeoutMs <= 0) {
      throw new Error(
        `${operation} could not start: the task wall-clock budget is exhausted.`,
      );
    }
    return runInterruptible(operation, timeoutMs, run, this.options.signal);
  }

  private async route(
    stage: Parameters<FastPathRouter["routeStage"]>[0]["stage"],
    actions: readonly SemanticAction[] | undefined,
    recoveryAttempt: number,
  ): Promise<StageRoute> {
    const failureReason = this.context.snapshot().failureReasons.at(-1);
    const input: StageRoutingInput = {
      stage,
      profile: this.options.profile,
      intent: this.options.intent,
      prediction: this.options.prediction,
      hasLocalPlan: Boolean(actions?.length),
      budget: this.budget,
      recoveryAttempt,
      ...(failureReason ? { failureReason } : {}),
    };
    const planned = this.options.config
      ? this.router.routeConfiguredStage(input, this.options.config)
      : this.router.routeStage(input);
    if (planned && this.options.config?.mode === "shadow") {
      this.routes.push(planned);
      this.context.setStage(stage);
      if (this.options.traceFilePath) {
        await appendStageRouteEvent(
          this.options.traceFilePath,
          this.options.taskId,
          planned,
          this.budget.snapshot().usage,
        );
      }
      return this.legacyRoute(stage, actions);
    }
    const route = planned ?? this.legacyRoute(stage, actions);
    this.routes.push(route);
    this.context.setStage(stage);
    if (this.options.traceFilePath) {
      await appendStageRouteEvent(
        this.options.traceFilePath,
        this.options.taskId,
        route,
        this.budget.snapshot().usage,
      );
    }
    return route;
  }

  private legacyRoute(
    stage: StageRoute["stage"],
    actions: readonly SemanticAction[] | undefined,
  ): StageRoute {
    const legacy = this.router.decide(
      this.options.prediction,
      this.options.intent,
      actions ? [...actions] : [],
    );
    const path =
      legacy.path === "fast"
        ? "local_fast"
        : legacy.path === "slow"
          ? "slow_planner"
          : legacy.path;
    return {
      stage,
      path,
      reason: legacy.reason,
      confidence: legacy.confidence,
      profile: this.options.profile,
      remainingBudget: this.budget.snapshot().remaining,
    };
  }

  private result(
    status: MultiPathTaskResult["status"],
    failureReason?: string,
    persistSummary = true,
  ): MultiPathTaskResult {
    const snapshot = this.budget.snapshot();
    const summary = this.context.summarize(this.options.intent);
    if (persistSummary) {
      this.options.summaryStore?.save(this.options.taskId, summary);
    }
    return {
      status,
      routes: [...this.routes],
      outcomes: [...this.outcomes],
      budget: snapshot.usage,
      remainingBudget: snapshot.remaining,
      summary,
      ...(failureReason ? { failureReason } : {}),
    };
  }
}
