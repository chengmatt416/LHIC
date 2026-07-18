import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  ConsoleNetworkObserver,
  createProductionExecutor,
  type PlaywrightDirectExecutor,
} from "@lhic/browser";
import {
  isBrowserExecutionPlan,
  type BrowserExecutionPlan,
  type BrowserSemanticAction,
} from "@lhic/schema";
import {
  createActionApproval,
  evaluateRisk,
  parseRuntimeConfig,
  type ActionApproval,
} from "@lhic/security";
import { VerifierEngine } from "@lhic/verifier";
import { chromium, type Browser, type Page } from "playwright";

import type { TaskApproval, TaskProposalSummary } from "../shared/contracts.js";

export interface BrowserRunResult {
  status: "awaiting_approval" | "completed" | "failed" | "cancelled";
  message: string;
  evidence: string[];
  proposal: TaskProposalSummary;
}

interface BrowserSession {
  browser: Browser;
  page: Page;
  executor: PlaywrightDirectExecutor;
  verifier: VerifierEngine;
  plan: BrowserExecutionPlan;
  nextStepIndex: number;
  evidence: string[];
}

/**
 * Executes a pre-validated plan in an isolated visible Playwright session.
 * It owns the browser locally and stops before every activation, download, or
 * elevated-risk action. No provider or MCP process receives this session.
 */
export class DesktopBrowserRunner {
  private readonly sessions = new Map<string, BrowserSession>();

  public constructor(private readonly workspaceRoot: string) {}

  public async execute(
    commandId: string,
    plan: BrowserExecutionPlan,
  ): Promise<BrowserRunResult> {
    if (!isBrowserExecutionPlan(plan)) {
      throw new Error(
        "Browser execution requires a valid browser-plan-v1 proposal.",
      );
    }
    if (this.sessions.has(commandId)) {
      throw new Error(
        "This task already has an active browser execution session.",
      );
    }
    const browser = await chromium.launch({ headless: false });
    const page = await browser.newPage();
    const networkObserver = new ConsoleNetworkObserver(page);
    const runtimeConfig = parseRuntimeConfig({
      ...process.env,
      LHIC_TRACE_DIRECTORY: resolve(this.workspaceRoot, ".lhic/traces"),
    });
    const session: BrowserSession = {
      browser,
      page,
      executor: createProductionExecutor(page, runtimeConfig, {
        taskId: commandId,
      }),
      verifier: new VerifierEngine({ page, networkObserver }),
      plan,
      nextStepIndex: 0,
      evidence: ["Browser execution session opened locally."],
    };
    this.sessions.set(commandId, session);
    return this.run(commandId);
  }

  public async approve(
    commandId: string,
    suppliedApproval?: TaskApproval,
  ): Promise<BrowserRunResult> {
    const session = this.require(commandId);
    const step = session.plan.steps[session.nextStepIndex];
    if (!step || !requiresInteractiveApproval(step.action)) {
      throw new Error("This task is not waiting for an action approval.");
    }
    const runtimeConfig = parseRuntimeConfig(process.env);
    if (runtimeConfig.environment === "production" && !suppliedApproval) {
      return this.waiting(
        session,
        "A signed external approval is required for this production action.",
      );
    }
    const approval: ActionApproval =
      suppliedApproval ??
      createActionApproval(step.action, "desktop-control-center", {
        now: new Date(),
        expiresInMs: 5 * 60_000,
      });
    const execution = await session.executor.execute(step.action, approval);
    if (!execution.success) {
      return this.finishFailure(
        commandId,
        session,
        execution.error ?? "The approved browser action failed.",
      );
    }
    const verification = await session.verifier.verify(step.verification);
    if (!verification.success || verification.evidence.length === 0) {
      return this.finishFailure(
        commandId,
        session,
        verification.error ?? "The post-action verifier produced no evidence.",
      );
    }
    session.evidence.push(...execution.evidence, ...verification.evidence);
    session.nextStepIndex += 1;
    return this.run(commandId);
  }

  public async cancel(commandId: string): Promise<void> {
    const session = this.sessions.get(commandId);
    this.sessions.delete(commandId);
    await session?.browser.close().catch(() => undefined);
  }

  public async close(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.cancel(id)));
  }

  private async run(commandId: string): Promise<BrowserRunResult> {
    const session = this.require(commandId);
    while (session.nextStepIndex < session.plan.steps.length) {
      const step = session.plan.steps[session.nextStepIndex]!;
      if (requiresInteractiveApproval(step.action)) {
        return this.waiting(
          session,
          `Approval is required before step ${session.nextStepIndex + 1}: ${step.action.intent}.`,
        );
      }
      const execution = await session.executor.execute(step.action);
      if (!execution.success) {
        return this.finishFailure(
          commandId,
          session,
          execution.error ?? "The browser action failed.",
        );
      }
      const verification = await session.verifier.verify(step.verification);
      if (!verification.success || verification.evidence.length === 0) {
        return this.finishFailure(
          commandId,
          session,
          verification.error ??
            "The post-action verifier produced no evidence.",
        );
      }
      session.evidence.push(...execution.evidence, ...verification.evidence);
      session.nextStepIndex += 1;
    }
    const result: BrowserRunResult = {
      status: "completed",
      message: "All browser steps completed with verifier evidence.",
      evidence: [...session.evidence],
      proposal: summarizePlan(session.plan),
    };
    await this.cancel(commandId);
    return result;
  }

  private waiting(session: BrowserSession, message: string): BrowserRunResult {
    return {
      status: "awaiting_approval",
      message,
      evidence: [...session.evidence],
      proposal: summarizePlan(session.plan),
    };
  }

  private async finishFailure(
    commandId: string,
    session: BrowserSession,
    message: string,
  ): Promise<BrowserRunResult> {
    const result: BrowserRunResult = {
      status: "failed",
      message,
      evidence: [...session.evidence],
      proposal: summarizePlan(session.plan),
    };
    await this.cancel(commandId);
    return result;
  }

  private require(commandId: string): BrowserSession {
    const session = this.sessions.get(commandId);
    if (!session)
      throw new Error("The browser execution session does not exist.");
    return session;
  }
}

export function requiresInteractiveApproval(
  action: BrowserSemanticAction,
): boolean {
  const risk = evaluateRisk(action);
  return (
    risk.requiresConfirmation ||
    action.riskLevel === "high" ||
    action.riskLevel === "unknown" ||
    action.type === "click" ||
    action.type === "press" ||
    action.type === "download"
  );
}

export function summarizePlan(plan: BrowserExecutionPlan): TaskProposalSummary {
  return {
    stepCount: plan.steps.length,
    steps: plan.steps.map((step) => {
      if (step.action.type === "custom") {
        throw new Error(
          "Custom actions cannot appear in a browser-plan-v1 proposal.",
        );
      }
      return {
        id: step.id,
        action: step.action.type,
        intent: step.action.intent,
        riskLevel: step.action.riskLevel,
        verifier: step.verification.description,
      };
    }),
  };
}

export function createTaskId(): string {
  return randomUUID();
}
