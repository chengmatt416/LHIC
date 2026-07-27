import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

import {
  BrowserStateObserver,
  ConsoleNetworkObserver,
  createProductionExecutor,
  type PlaywrightDirectExecutor,
} from "@lhic/browser";
import {
  isBrowserExecutionPlan,
  type BrowserExecutionPlan,
  type BrowserSemanticAction,
  type NormalizedUIState,
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
  status:
    "awaiting_approval" | "blocked" | "completed" | "failed" | "cancelled";
  message: string;
  evidence: string[];
  proposal: TaskProposalSummary;
}

export interface BrowserReadiness {
  ready: boolean;
  executablePath: string;
  message: string;
}

export interface BrowserIntentAdmissionResult {
  allowed: boolean;
  message: string;
  evidence: string[];
}

/**
 * A local, fail-closed decision made from the live normalized browser state.
 * The callback never receives the Playwright page, executor, verifier, or any
 * provider handle.
 */
export type BrowserIntentAdmission = (
  uiState: NormalizedUIState,
) => BrowserIntentAdmissionResult | Promise<BrowserIntentAdmissionResult>;

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

  public async readiness(): Promise<BrowserReadiness> {
    const executablePath = chromium.executablePath();
    try {
      await access(executablePath);
      return {
        ready: true,
        executablePath,
        message: "Playwright Chromium is ready for local browser tasks.",
      };
    } catch {
      return {
        ready: false,
        executablePath,
        message:
          "Playwright Chromium is not installed. Run `lhic install cli` or `npx playwright install chromium`, then retry.",
      };
    }
  }

  public async execute(
    commandId: string,
    plan: BrowserExecutionPlan,
    admission?: BrowserIntentAdmission,
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
    const readiness = await this.readiness();
    if (!readiness.ready) throw new Error(readiness.message);
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

    if (admission) {
      const blocked = await this.prepareLiveIntentAdmission(
        commandId,
        session,
        networkObserver,
        admission,
      );
      if (blocked) return blocked;
    }
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
    session.executor.rememberVerifiedAction(step.action, verification);
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

  private async prepareLiveIntentAdmission(
    commandId: string,
    session: BrowserSession,
    networkObserver: ConsoleNetworkObserver,
    admission: BrowserIntentAdmission,
  ): Promise<BrowserRunResult | undefined> {
    const observationStep = session.plan.steps[0];
    if (
      !observationStep ||
      observationStep.action.type !== "navigate" ||
      observationStep.action.riskLevel !== "low" ||
      requiresInteractiveApproval(observationStep.action) ||
      !isHttpTarget(observationStep.action.target)
    ) {
      return this.finishBlocked(
        commandId,
        session,
        "Human-intent admission requires one fixed low-risk HTTP(S) navigation step before live UI observation.",
        ["No mutable browser action was executed."],
      );
    }

    const navigation = await session.executor.execute(observationStep.action);
    if (!navigation.success) {
      return this.finishFailure(
        commandId,
        session,
        navigation.error ?? "The observation page could not be opened.",
      );
    }
    const navigationVerification = await session.verifier.verify(
      observationStep.verification,
    );
    if (
      !navigationVerification.success ||
      navigationVerification.evidence.length === 0
    ) {
      return this.finishFailure(
        commandId,
        session,
        navigationVerification.error ??
          "The observation navigation produced no verifier evidence.",
      );
    }
    session.executor.rememberVerifiedAction(
      observationStep.action,
      navigationVerification,
    );
    session.nextStepIndex = 1;
    session.evidence.push(
      "A fixed low-risk navigation opened the observation page; no fill, press, click, download, or elevated-risk action ran before Human Intent admission.",
      ...navigation.evidence,
      ...navigationVerification.evidence,
    );

    const observer = new BrowserStateObserver(session.page, networkObserver);
    const uiState = await observer.observe();
    let decision: BrowserIntentAdmissionResult;
    try {
      decision = await admission(uiState);
    } catch {
      return this.finishBlocked(
        commandId,
        session,
        "Human-intent admission failed closed before mutable task actions.",
        ["The local admission callback raised an error."],
      );
    }
    session.evidence.push(...decision.evidence);
    if (!decision.allowed) {
      return this.finishBlocked(commandId, session, decision.message, [
        "Human Intent admission denied the deterministic plan.",
      ]);
    }
    session.evidence.push(decision.message);
    return undefined;
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
      session.executor.rememberVerifiedAction(step.action, verification);
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

  private async finishBlocked(
    commandId: string,
    session: BrowserSession,
    message: string,
    evidence: string[] = [],
  ): Promise<BrowserRunResult> {
    const result: BrowserRunResult = {
      status: "blocked",
      message,
      evidence: [...session.evidence, ...evidence],
      proposal: summarizePlan(session.plan),
    };
    await this.cancel(commandId);
    return result;
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

function isHttpTarget(target: unknown): target is string {
  if (typeof target !== "string") return false;
  try {
    const url = new URL(target);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
