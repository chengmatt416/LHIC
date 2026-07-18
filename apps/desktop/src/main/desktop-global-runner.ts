import { resolve } from "node:path";

import {
  isDesktopExecutionPlan,
  type DesktopExecutionPlan,
  type GlobalComputerAction,
} from "@lhic/schema";
import { GlobalComputerExecutor } from "@lhic/skills";

import type { TaskApproval, TaskProposalSummary } from "../shared/contracts.js";

export interface GlobalRunResult {
  status: "awaiting_approval" | "completed" | "failed" | "cancelled";
  message: string;
  evidence: string[];
  proposal: TaskProposalSummary;
}

interface GlobalSession {
  plan: DesktopExecutionPlan;
  nextStepIndex: number;
  evidence: string[];
}

/**
 * Executes Slow Path desktop plans locally. OS actions are deliberately never
 * auto-approved: the global executor verifies a matching approval and a local
 * observable condition for every step.
 */
export class DesktopGlobalRunner {
  private readonly sessions = new Map<string, GlobalSession>();

  public constructor(private readonly workspaceRoot: string) {}

  public execute(
    commandId: string,
    plan: DesktopExecutionPlan,
  ): GlobalRunResult {
    if (!isDesktopExecutionPlan(plan)) {
      throw new Error(
        "Desktop execution requires a valid desktop-plan-v1 proposal.",
      );
    }
    if (this.sessions.has(commandId)) {
      throw new Error(
        "This task already has an active desktop execution session.",
      );
    }
    const session: GlobalSession = {
      plan,
      nextStepIndex: 0,
      evidence: ["Desktop execution session prepared locally."],
    };
    this.sessions.set(commandId, session);
    return this.waiting(
      session,
      `Approval is required before desktop step 1: ${plan.steps[0]!.action.intent}.`,
    );
  }

  public async approve(
    commandId: string,
    approval?: TaskApproval,
  ): Promise<GlobalRunResult> {
    const session = this.require(commandId);
    const step = session.plan.steps[session.nextStepIndex];
    if (!step) throw new Error("This desktop task has no pending action.");

    const executor = new GlobalComputerExecutor({
      taskId: commandId,
      traceFilePath: resolve(
        this.workspaceRoot,
        ".lhic/traces",
        `${commandId}.jsonl`,
      ),
    });
    const execution = await executor.execute(step.action, approval);
    if (!execution.success) {
      return this.finishFailure(
        commandId,
        session,
        execution.error ?? "The approved desktop action failed.",
      );
    }
    session.evidence.push(...execution.evidence);
    session.nextStepIndex += 1;
    if (session.nextStepIndex >= session.plan.steps.length) {
      const result: GlobalRunResult = {
        status: "completed",
        message: "All desktop steps completed with local verifier evidence.",
        evidence: [...session.evidence],
        proposal: summarizeDesktopPlan(session.plan),
      };
      this.sessions.delete(commandId);
      return result;
    }
    const next = session.plan.steps[session.nextStepIndex]!;
    return this.waiting(
      session,
      `Approval is required before desktop step ${session.nextStepIndex + 1}: ${next.action.intent}.`,
    );
  }

  public cancel(commandId: string): void {
    this.sessions.delete(commandId);
  }

  private waiting(session: GlobalSession, message: string): GlobalRunResult {
    return {
      status: "awaiting_approval",
      message,
      evidence: [...session.evidence],
      proposal: summarizeDesktopPlan(session.plan),
    };
  }

  private finishFailure(
    commandId: string,
    session: GlobalSession,
    message: string,
  ): GlobalRunResult {
    const result: GlobalRunResult = {
      status: "failed",
      message,
      evidence: [...session.evidence],
      proposal: summarizeDesktopPlan(session.plan),
    };
    this.sessions.delete(commandId);
    return result;
  }

  private require(commandId: string): GlobalSession {
    const session = this.sessions.get(commandId);
    if (!session)
      throw new Error("The desktop execution session does not exist.");
    return session;
  }
}

export function summarizeDesktopPlan(
  plan: DesktopExecutionPlan,
): TaskProposalSummary {
  return {
    stepCount: plan.steps.length,
    steps: plan.steps.map((step) =>
      summarizeGlobalAction(step.id, step.action),
    ),
  };
}

function summarizeGlobalAction(id: string, action: GlobalComputerAction) {
  return {
    id,
    action: action.type,
    intent: action.intent,
    riskLevel: action.riskLevel,
    verifier:
      action.verifier.type === "active_window"
        ? `Active window${action.verifier.application ? `: ${action.verifier.application}` : ""}`
        : `Running process: ${action.verifier.application}`,
  };
}
