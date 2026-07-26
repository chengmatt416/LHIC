import {
  FastPathRouter,
  HumanIntentLearnLoop,
  PredictionFirstHumanIntentController,
  parseUserIntent,
  type HumanIntentCorrectionBinding,
  type LearnLoopRule,
  type PredictionFirstRouteResult,
  type SignedHumanIntentCorrectionApproval,
  type TrustedHumanIntentCorrectionIngestion,
} from "@lhic/controller";
import type {
  BrowserExecutionPlan,
  NormalizedUIState,
  SemanticAction,
} from "@lhic/schema";

export interface DesktopHumanIntentAdmissionDecision {
  allowed: boolean;
  message: string;
  evidence: string[];
  route: PredictionFirstRouteResult;
}

export interface DesktopHumanIntentAdmissionOptions {
  learnLoop?: HumanIntentLearnLoop;
  controller?: PredictionFirstHumanIntentController;
  correctionIngestion?: Pick<
    TrustedHumanIntentCorrectionIngestion,
    "ingest"
  >;
}

/**
 * Evaluates a precompiled local browser plan against live normalized UI state.
 * LearnLoop may calibrate the predicted stage, but it may not replace the
 * deterministic plan: the authoritative router must independently reproduce
 * the same built-in skill and action fingerprints before execution continues.
 */
export class DesktopHumanIntentAdmission {
  private readonly learnLoop: HumanIntentLearnLoop;
  private readonly controller: PredictionFirstHumanIntentController;
  private readonly correctionIngestion:
    | Pick<TrustedHumanIntentCorrectionIngestion, "ingest">
    | undefined;

  public constructor(options: DesktopHumanIntentAdmissionOptions = {}) {
    if (options.controller && options.correctionIngestion) {
      throw new Error(
        "Trusted correction ingestion requires the admission-owned LearnLoop; an externally supplied controller cannot prove that shared binding.",
      );
    }
    this.learnLoop = options.learnLoop ?? new HumanIntentLearnLoop();
    this.controller =
      options.controller ??
      new PredictionFirstHumanIntentController(
        new FastPathRouter(),
        this.learnLoop,
      );
    this.correctionIngestion = options.correctionIngestion;
  }

  public evaluate(
    sessionId: string,
    goal: string,
    expectedPlan: BrowserExecutionPlan,
    uiState: NormalizedUIState,
  ): DesktopHumanIntentAdmissionDecision {
    const route = this.controller.route(
      sessionId,
      parseUserIntent(goal),
      uiState,
    );
    const expectedActions = expectedPlan.steps
      .map((step) => step.action)
      .filter((action) => action.type !== "navigate")
      .map(actionFingerprint);
    const routedActions = route.route.plan.actions.map(actionFingerprint);
    const actionMatch = sameSequence(expectedActions, routedActions);
    const skillMatch =
      Boolean(expectedPlan.skillName) &&
      route.route.plan.skillName === expectedPlan.skillName;
    const builtinPlan = route.route.plan.source === "builtin";
    const completePlan = route.route.plan.missingInformation.length === 0;
    const fastRoute = route.route.decision.path === "fast";
    const allowed =
      fastRoute && builtinPlan && completePlan && skillMatch && actionMatch;

    const evidence = [
      "Human Intent prediction ran against live normalized UI before task actions.",
      `Base intent: ${route.humanIntent.basePrediction.predictedIntent}; final intent: ${route.humanIntent.prediction.predictedIntent}.`,
      `Final confidence: ${route.humanIntent.prediction.confidence.toFixed(3)}; decision latency: ${route.humanIntent.decisionLatencyMs.toFixed(3)} ms.`,
      `Intent Drift ${route.humanIntent.drift.detected ? "detected" : "not detected"} at score ${route.humanIntent.drift.score.toFixed(3)}.`,
      `LearnLoop applied ${route.humanIntent.appliedRuleIds.length} active rule(s).`,
      `FastPathRouter selected ${route.route.decision.path}: ${route.route.decision.reason}`,
      `Deterministic plan reproduction: builtin=${String(builtinPlan)}, complete=${String(completePlan)}, skillMatch=${String(skillMatch)}, actionMatch=${String(actionMatch)}.`,
    ];

    return {
      allowed,
      message: allowed
        ? "Human-intent admission accepted the deterministic local Fast Path."
        : fastRoute
          ? "Human-intent admission blocked execution because the authoritative router did not reproduce the exact deterministic plan."
          : `Human-intent admission blocked execution: ${route.route.decision.reason}`,
      evidence,
      route,
    };
  }

  /**
   * Applies one externally signed, verifier-bound correction to the exact
   * LearnLoop used by evaluate(). No correction is accepted unless a trusted
   * ingestion boundary was explicitly injected at construction time.
   */
  public ingestCorrection(
    binding: HumanIntentCorrectionBinding,
    approval: SignedHumanIntentCorrectionApproval,
  ): LearnLoopRule {
    if (!this.correctionIngestion) {
      throw new Error(
        "Trusted Human Intent correction ingestion is not configured for this Desktop runtime.",
      );
    }
    return this.correctionIngestion.ingest(
      this.learnLoop,
      binding,
      approval,
    );
  }
}

function actionFingerprint(action: SemanticAction): string {
  return JSON.stringify({
    type: action.type,
    target: typeof action.target === "string" ? action.target : "",
    value:
      "value" in action && typeof action.value === "string" ? action.value : "",
    riskLevel: action.riskLevel,
    methodPreference: [...action.methodPreference],
  });
}

function sameSequence(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
