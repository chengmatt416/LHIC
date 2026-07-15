import type { NormalizedUIState, RiskLevel } from "@lhic/schema";

export interface ControllerContext {
  taskId: string;
  currentGoal: string;
  currentUrl?: string;
  currentApp?: string;
  completedSteps: string[];
  lastUIState?: NormalizedUIState;
  riskFlags: RiskLevel[];
}

export class ContextEngine {
  private readonly context: ControllerContext;

  public constructor(taskId: string, currentGoal: string) {
    this.context = { taskId, currentGoal, completedSteps: [], riskFlags: [] };
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

  public flagRisk(riskLevel: RiskLevel): void {
    if (!this.context.riskFlags.includes(riskLevel)) {
      this.context.riskFlags.push(riskLevel);
    }
  }

  public snapshot(): ControllerContext {
    return {
      ...this.context,
      completedSteps: [...this.context.completedSteps],
      riskFlags: [...this.context.riskFlags],
    };
  }
}
