import type {
  ControllerStage,
  NormalizedUIState,
  RiskLevel,
  TraceEvent,
  UserIntent,
} from "@lhic/schema";

import { createTaskSummary, type TaskSummary } from "./task-summary.js";

export interface ControllerContext {
  taskId: string;
  currentGoal: string;
  currentUrl?: string;
  currentApp?: string;
  completedSteps: string[];
  verifiedEvidence: string[];
  failureReasons: string[];
  currentStage?: ControllerStage;
  lastUIState?: NormalizedUIState;
  riskFlags: RiskLevel[];
}

export class ContextEngine {
  private readonly context: ControllerContext;

  public constructor(taskId: string, currentGoal: string) {
    this.context = {
      taskId,
      currentGoal,
      completedSteps: [],
      verifiedEvidence: [],
      failureReasons: [],
      riskFlags: [],
    };
  }

  public setLocation(location: { url?: string; app?: string }): void {
    if (location.url !== undefined) {
      this.context.currentUrl = location.url;
    }
    if (location.app !== undefined) {
      this.context.currentApp = location.app;
    }
  }

  public setUIState(state: NormalizedUIState): void {
    this.context.lastUIState = state;
    this.setLocation({
      ...(state.url !== undefined ? { url: state.url } : {}),
      ...(state.app !== undefined ? { app: state.app } : {}),
    });
  }

  public completeStep(step: string): void {
    if (!this.context.completedSteps.includes(step)) {
      this.context.completedSteps.push(step);
    }
  }

  public setStage(stage: ControllerStage): void {
    this.context.currentStage = stage;
  }

  public recordVerification(evidence: readonly string[]): void {
    for (const entry of evidence) {
      if (entry.trim() && !this.context.verifiedEvidence.includes(entry)) {
        this.context.verifiedEvidence.push(entry);
      }
    }
  }

  public recordFailure(reason: string): void {
    if (reason.trim() && !this.context.failureReasons.includes(reason)) {
      this.context.failureReasons.push(reason);
    }
  }

  public flagRisk(riskLevel: RiskLevel): void {
    if (!this.context.riskFlags.includes(riskLevel)) {
      this.context.riskFlags.push(riskLevel);
    }
  }

  public snapshot(): ControllerContext {
    return {
      ...this.context,
      completedSteps: [...this.context.completedSteps],
      verifiedEvidence: [...this.context.verifiedEvidence],
      failureReasons: [...this.context.failureReasons],
      riskFlags: [...this.context.riskFlags],
    };
  }

  public summarize(
    intent: UserIntent,
    nextStage?: ControllerStage,
    recentTrace?: readonly TraceEvent[],
  ): TaskSummary {
    return createTaskSummary({
      intent,
      ...(this.context.lastUIState
        ? { uiState: this.context.lastUIState }
        : {}),
      completedSteps: this.context.completedSteps,
      verifiedEvidence: this.context.verifiedEvidence,
      failureReasons: this.context.failureReasons,
      ...(nextStage ? { nextStage } : {}),
      ...(recentTrace ? { recentTrace } : {}),
    });
  }
}
