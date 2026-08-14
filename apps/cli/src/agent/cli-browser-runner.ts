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
import { effectiveSideEffectClass, inferSideEffectClass } from "@lhic/security";
import { hashState } from "@lhic/trace";
import { VerifierEngine } from "@lhic/verifier";
import type { VerificationCondition, VerificationResult } from "@lhic/schema";
import { chromium, type Browser, type Page } from "playwright";

import type { LedgerCoordinator } from "./ledger-coordinator.js";
import type { ReceiptRecorder } from "./receipt-recorder.js";
import { evidenceRefs } from "./receipt-recorder.js";

export interface BrowserRunResult {
  status: "awaiting_approval" | "completed" | "failed" | "cancelled";
  message: string;
  evidence: string[];
  proposal: TaskProposalSummary;
}

export interface CliBrowserRunnerOptions {
  receiptRecorder?: ReceiptRecorder;
  coordinator?: LedgerCoordinator;
}

export interface TaskProposalSummary {
  stepCount: number;
  steps: Array<{
    id: string;
    action: string;
    intent: string;
    riskLevel: string;
    verifier: string;
  }>;
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
 * Executes a pre-validated browser-plan-v1 in an isolated visible Playwright
 * session — the CLI twin of the desktop's browser runner, with the same
 * per-step approval and verifier-evidence gates.
 */
export class CliBrowserRunner {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly receiptRecorder: ReceiptRecorder | undefined;
  private readonly coordinator: LedgerCoordinator | undefined;

  public constructor(
    private readonly workspaceRoot: string,
    options: CliBrowserRunnerOptions = {},
  ) {
    this.receiptRecorder = options.receiptRecorder;
    this.coordinator = options.coordinator;
  }

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
    return this.recoverAndRun(commandId);
  }

  /**
   * Recovers ambiguous ledger state before running: a possibly-committed
   * step is re-observed (never blindly replayed). Verified steps are skipped;
   * unprovable ones fail the task as needs_resolution.
   */
  private async recoverAndRun(commandId: string): Promise<BrowserRunResult> {
    const session = this.require(commandId);
    if (!this.coordinator) return this.run(commandId);
    const pending = this.coordinator.recoverPending();
    if (pending.length === 0) return this.run(commandId);
    let furthestRecovered = -1;
    for (const entry of pending) {
      const stepIndex = session.plan.steps.findIndex(
        (step) => step.id === entry.actionId,
      );
      if (stepIndex < 0) continue;
      const step = session.plan.steps[stepIndex]!;
      const verification = await session.verifier.verify(step.verification);
      const happened = verification.success && verification.evidence.length > 0;
      const outcome = this.coordinator.recover(entry.actionId, {
        sideEffectHappened: happened,
        evidenceRefs: evidenceRefs(verification.evidence),
      });
      if (outcome === "verified") {
        session.evidence.push(...verification.evidence);
        furthestRecovered = Math.max(furthestRecovered, stepIndex);
      }
    }
    if (furthestRecovered >= 0) {
      session.nextStepIndex = furthestRecovered + 1;
      return this.run(commandId);
    }
    return this.finishFailure(
      commandId,
      session,
      "A previous dispatch of this task is ambiguous (needs resolution); refusing to replay a possibly-committed side effect.",
    );
  }

  /**
   * Ledger-guarded dispatch: possibly_committed is recorded before the
   * physical side effect; verified only after non-empty verifier evidence.
   */
  private async dispatchStep(
    session: BrowserSession,
    step: {
      id: string;
      action: BrowserSemanticAction;
      verification: VerificationCondition;
    },
    approval?: ActionApproval,
  ): Promise<{
    ok: boolean;
    error?: string;
    verification?: VerificationResult;
    evidence: string[];
  }> {
    if (this.coordinator) {
      const actionId = step.id;
      const actionHash = hashState(step.action);
      const sideEffectClass = effectiveSideEffectClass(
        undefined,
        inferSideEffectClass(step.action),
      );
      const entry = this.coordinator.get(actionId);
      if (!entry) {
        this.coordinator.begin(
          actionId,
          actionHash,
          sideEffectClass,
          approval?.expiresAt,
        );
      }
      if (approval) this.coordinator.approve(actionId);
      this.coordinator.beforeDispatch(actionId);
    }
    const execution = await session.executor.execute(step.action, approval);
    if (this.coordinator) this.coordinator.afterDispatch(step.id);
    if (!execution.success) {
      if (this.coordinator) this.coordinator.verifyFailed(step.id);
      const error = execution.error ?? "The browser action failed.";
      return { ok: false, error, evidence: [] };
    }
    const verification = await session.verifier.verify(step.verification);
    if (!verification.success || verification.evidence.length === 0) {
      if (this.coordinator) this.coordinator.verifyFailed(step.id);
      return {
        ok: false,
        error:
          verification.error ??
          "The post-action verifier produced no evidence.",
        evidence: [],
      };
    }
    if (this.coordinator) {
      this.coordinator.verifySucceeded(
        step.id,
        evidenceRefs(verification.evidence),
      );
    }
    return {
      ok: true,
      verification,
      evidence: [...execution.evidence, ...verification.evidence],
    };
  }
  public pendingAction(commandId: string): {
    action: BrowserSemanticAction;
    verifier: string;
  } {
    const session = this.require(commandId);
    const step = session.plan.steps[session.nextStepIndex];
    if (!step) throw new Error("This browser task has no pending action.");
    return { action: step.action, verifier: step.verification.description };
  }

  public async approve(
    commandId: string,
    suppliedApproval?: ActionApproval,
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
      createActionApproval(step.action, "lhic-cli", {
        now: new Date(),
        expiresInMs: 5 * 60_000,
      });
    const execution = await this.dispatchStep(session, step, approval);
    if (!execution.ok) {
      await this.recordReceipt(
        session,
        step,
        "failed",
        approval,
        undefined,
        execution.error ?? "The approved browser action failed.",
      );
      return this.finishFailure(
        commandId,
        session,
        execution.error ?? "The approved browser action failed.",
      );
    }
    if (execution.verification) {
      session.executor.rememberVerifiedAction(
        step.action,
        execution.verification,
      );
    }
    session.evidence.push(...execution.evidence);
    await this.recordReceipt(
      session,
      step,
      "verified",
      approval,
      execution.evidence,
    );
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
      const execution = await this.dispatchStep(session, step);
      if (!execution.ok) {
        await this.recordReceipt(
          session,
          step,
          "failed",
          undefined,
          undefined,
          execution.error ?? "The browser action failed.",
        );
        return this.finishFailure(
          commandId,
          session,
          execution.error ?? "The browser action failed.",
        );
      }
      if (execution.verification) {
        session.executor.rememberVerifiedAction(
          step.action,
          execution.verification,
        );
      }
      session.evidence.push(...execution.evidence);
      await this.recordReceipt(
        session,
        step,
        "verified",
        undefined,
        execution.evidence,
      );
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

  private async recordReceipt(
    session: BrowserSession,
    step: { id: string; action: BrowserSemanticAction },
    state: "verified" | "failed",
    approval: ActionApproval | undefined,
    stepEvidence: string[] | undefined,
    failureReason?: string,
  ): Promise<void> {
    if (!this.receiptRecorder) return;
    await this.receiptRecorder.record({
      surface: "browser",
      actionId: step.id,
      tool: "lhic_browser_execute",
      action: step.action,
      ...(approval ? { approval } : {}),
      approvalStatus: approval ? "approved" : "not_required",
      executorBackend: "playwright",
      verificationStatus: state === "verified" ? "passed" : "failed",
      verificationAuthority: state === "verified" ? "lhic" : "none",
      evidenceRefs: stepEvidence ? evidenceRefs(stepEvidence) : [],
      state,
      ...(failureReason ? { failureReason } : {}),
      startedAt: new Date().toISOString(),
    });
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
    action.type === "download" ||
    action.type === "upload"
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
