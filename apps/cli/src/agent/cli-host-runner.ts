import { join, resolve } from "node:path";

import {
  isBrowserExecutionPlan,
  isDesktopExecutionPlan,
  type DesktopExecutionPlan,
  type GlobalComputerAction,
  type SemanticAction,
} from "@lhic/schema";
import {
  createActionApproval,
  parseRuntimeConfig,
  type ActionApproval,
} from "@lhic/security";
import {
  buildGlobalComputerCommand,
  ElementGroundedDispatcher,
  ExecFileGlobalCommandRunner,
  executionBackendOptionsFromEnvironment,
  getGlobalDesktopPlatform,
  GlobalComputerExecutor,
  resolveExecutionChain,
} from "@lhic/skills";
import { materializeActionApproval } from "./approval-materializer.js";

import {
  CliBrowserRunner,
  summarizePlan,
  createTaskId,
  type BrowserRunResult,
  type TaskProposalSummary,
} from "./cli-browser-runner.js";

export type { TaskProposalSummary };

export interface CliHostRunnerDeps {
  workspaceRoot: string;
  approvedBy?: string;
  promptApproval: (
    request: HostApprovalRequest,
  ) => Promise<HostApprovalDecision>;
  approvalPolicy?: "ask" | "deny" | "auto";
  emitResult: (
    callId: string,
    result: Record<string, unknown>,
    isError: boolean,
  ) => void;
  emitUpdate: (callId: string, partialResult: Record<string, unknown>) => void;
}
export interface HostApprovalRequest {
  surface: "browser" | "desktop";
  actionHash: string;
  riskLevel: "low" | "medium" | "high" | "unknown";
  intent: string;
  verifier: string;
  toolName: string;
  proposal: TaskProposalSummary;
}

export type HostApprovalDecision =
  | { approved: false }
  | { approved: true; approvedBy: string; approval?: ActionApproval };

const browserToolName = "lhic_browser_execute";
const desktopToolName = "lhic_desktop_execute";
const desktopObserveToolName = "lhic_desktop_observe";

/**
 * Serves the omp agent's LHIC host tools from the CLI: browser plans run in
 * a visible Playwright session, desktop plans through the global executor —
 * both with per-step terminal approval and verifier evidence, exactly like
 * the desktop app's approval-gated runners.
 */
export class CliHostRunner {
  private readonly pending = new Map<
    string,
    { commandId: string; toolName: string }
  >();
  private readonly browserRunner: CliBrowserRunner;
  private readonly desktopSessions = new Map<
    string,
    { plan: DesktopExecutionPlan; nextStepIndex: number; evidence: string[] }
  >();
  private readonly deps: CliHostRunnerDeps;

  public constructor(deps: CliHostRunnerDeps) {
    this.deps = deps;
    this.browserRunner = new CliBrowserRunner(deps.workspaceRoot);
  }

  public handleHostToolCall(frame: Record<string, unknown>): void {
    if (frame.type === "host_tool_cancel") {
      this.cancel(String(frame.targetId ?? ""));
      return;
    }
    const callId = String(frame.id ?? "");
    const toolName = String(frame.toolName ?? "");
    if (!callId) return;
    const argsValue = frame.arguments;
    const args =
      argsValue && typeof argsValue === "object"
        ? (argsValue as Record<string, unknown>)
        : {};
    if (
      toolName !== browserToolName &&
      toolName !== desktopToolName &&
      toolName !== desktopObserveToolName
    ) {
      this.emitResult(
        callId,
        {
          content: [
            { type: "text", text: `Unsupported host tool: ${toolName}` },
          ],
        },
        true,
      );
      return;
    }
    if (toolName === desktopObserveToolName) {
      void this.observe(callId, args);
      return;
    }
    const commandId = createTaskId();
    this.pending.set(callId, { commandId, toolName });
    const run =
      toolName === browserToolName
        ? this.browserRunner.execute(
            commandId,
            args.plan as Parameters<CliBrowserRunner["execute"]>[1],
          )
        : this.desktopExecute(commandId, args.plan as DesktopExecutionPlan);
    void run
      .then((result) => {
        if (!this.pending.has(callId)) return;
        void this.recordResult(callId, result);
      })
      .catch((error: unknown) => {
        if (!this.pending.has(callId)) return;
        this.pending.delete(callId);
        this.emitResult(
          callId,
          {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          },
          true,
        );
      });
  }

  public async close(): Promise<void> {
    await this.browserRunner.close();
    for (const callId of [...this.pending.keys()]) {
      this.cancel(callId);
    }
  }

  private async observe(
    callId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      const scope = args.scope;
      const application = args.application;
      if (
        scope !== "active_window" &&
        scope !== "all_windows" &&
        scope !== "application"
      ) {
        throw new Error("Desktop observation scope is invalid.");
      }
      if (scope === "application" && typeof application !== "string") {
        throw new Error(
          "Application-scoped observation requires an application.",
        );
      }
      const action: GlobalComputerAction = {
        scope: "os",
        type: "os_observe",
        intent:
          typeof application === "string"
            ? `Observe ${application}`
            : `Observe ${scope.replace("_", " ")}`,
        methodPreference: ["accessibility", "vision"],
        riskLevel: "medium",
        observeScope: scope,
        ...(typeof application === "string" ? { application } : {}),
        verifier: {
          type: "active_window",
          ...(typeof application === "string" ? { application } : {}),
        },
      };
      const challenge = createActionApproval(action, "pending-human-approval");
      const decision = await this.approvalDecision(
        desktopObserveToolName,
        {
          stepCount: 1,
          steps: [
            {
              id: "observe",
              action: "os_observe",
              intent: action.intent,
              riskLevel: action.riskLevel,
              verifier: "Bounded normalized desktop observation",
            },
          ],
        },
        { action, verifier: "bounded normalized desktop observation" },
      );
      if (!decision.approved) {
        throw new Error("Rejected by user.");
      }
      const approval = materializeActionApproval(action, decision, {
        production: process.env.LHIC_ENV === "production",
      });
      const options = executionBackendOptionsFromEnvironment();
      const chain = await resolveExecutionChain(options);
      const runner = new ExecFileGlobalCommandRunner();
      const dispatcher =
        chain.backend || chain.omniparser
          ? new ElementGroundedDispatcher({
              ...(chain.backend ? { backend: chain.backend } : {}),
              ...(chain.omniparser ? { omniparser: chain.omniparser } : {}),
              runner,
              platform: process.platform,
              buildNative: (candidate) =>
                buildGlobalComputerCommand(
                  candidate,
                  getGlobalDesktopPlatform(),
                ),
              ...(options.redactValues
                ? { redactValues: options.redactValues }
                : {}),
            })
          : undefined;
      const executor = new GlobalComputerExecutor({
        taskId: `observe-${challenge.actionHash.slice(0, 12)}`,
        traceFilePath: resolve(
          this.deps.workspaceRoot,
          ".lhic/traces/desktop-observation.jsonl",
        ),
        ...(dispatcher ? { dispatcher } : {}),
      });
      const result = await executor.observe(action, approval);
      this.emitResult(
        callId,
        {
          content: [
            {
              type: "text",
              text: result.success
                ? (result.output ?? JSON.stringify({ elements: [] }))
                : (result.error ?? "Desktop observation failed."),
            },
          ],
        },
        !result.success,
      );
    } catch (error) {
      this.emitResult(
        callId,
        {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        },
        true,
      );
    }
  }

  private desktopExecute(
    commandId: string,
    plan: DesktopExecutionPlan,
  ): Promise<DesktopRunResult> {
    if (!isDesktopExecutionPlan(plan)) {
      return Promise.reject(
        new Error(
          "Desktop execution requires a valid desktop-plan-v1 proposal.",
        ),
      );
    }
    this.desktopSessions.set(commandId, {
      plan,
      nextStepIndex: 0,
      evidence: ["Desktop execution session prepared locally."],
    });
    return Promise.resolve(this.desktopWaiting(commandId));
  }

  private async desktopApprove(
    commandId: string,
    approval: ActionApproval,
  ): Promise<DesktopRunResult> {
    const session = this.desktopSessions.get(commandId);
    if (!session) throw new Error("The desktop session does not exist.");
    const step = session.plan.steps[session.nextStepIndex];
    if (!step) throw new Error("This desktop task has no pending action.");
    const runtimeConfig = parseRuntimeConfig({
      ...process.env,
      LHIC_TRACE_DIRECTORY: resolve(this.deps.workspaceRoot, ".lhic/traces"),
    });
    const executor = new GlobalComputerExecutor({
      taskId: commandId,
      traceFilePath: join(runtimeConfig.traceDirectory, `${commandId}.jsonl`),
      approvalValidation: {
        requireSignature: runtimeConfig.environment === "production",
        ...(runtimeConfig.approvalPublicKey
          ? { publicKey: runtimeConfig.approvalPublicKey }
          : {}),
      },
    });
    const execution = await executor.execute(step.action, approval);
    if (!execution.success) {
      return this.desktopFailure(
        commandId,
        execution.error ?? "Desktop action failed.",
      );
    }
    session.evidence.push(...execution.evidence);
    session.nextStepIndex += 1;
    if (session.nextStepIndex >= session.plan.steps.length) {
      const result: DesktopRunResult = {
        status: "completed",
        message: "All desktop steps completed with verifier evidence.",
        evidence: [...session.evidence],
        proposal: summarizeDesktopPlan(session.plan),
      };
      this.desktopSessions.delete(commandId);
      return result;
    }
    return this.desktopWaiting(commandId);
  }

  private desktopWaiting(commandId: string): DesktopRunResult {
    const session = this.desktopSessions.get(commandId)!;
    const next = session.plan.steps[session.nextStepIndex]!;
    return {
      status: "awaiting_approval",
      message: `Approval is required before desktop step ${session.nextStepIndex + 1}: ${next.action.intent}.`,
      evidence: [...session.evidence],
      proposal: summarizeDesktopPlan(session.plan),
    };
  }

  private desktopFailure(commandId: string, message: string): DesktopRunResult {
    const session = this.desktopSessions.get(commandId)!;
    const result: DesktopRunResult = {
      status: "failed",
      message,
      evidence: [...session.evidence],
      proposal: summarizeDesktopPlan(session.plan),
    };
    this.desktopSessions.delete(commandId);
    return result;
  }

  private cancel(callId: string): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    if (pending.toolName === browserToolName) {
      void this.browserRunner.cancel(pending.commandId).catch(() => undefined);
    } else {
      this.desktopSessions.delete(pending.commandId);
    }
  }

  private async recordResult(
    callId: string,
    result: BrowserRunResult | DesktopRunResult,
  ): Promise<void> {
    if (result.status === "awaiting_approval") {
      this.emitUpdate(callId, {
        content: [{ type: "text", text: "Waiting for approval…" }],
      });
      const pending = this.pending.get(callId);
      if (!pending) return;
      const approvalContext = this.pendingAction(pending);
      const decision = await this.approvalDecision(
        pending.toolName,
        result.proposal,
        approvalContext,
      );
      if (!this.pending.has(callId)) return;
      if (!decision.approved) {
        await this.reject(callId);
        return;
      }
      try {
        const runtimeConfig = parseRuntimeConfig(process.env);
        const approval = materializeActionApproval(
          approvalContext.action,
          decision,
          {
            production: runtimeConfig.environment === "production",
            ...(runtimeConfig.approvalPublicKey
              ? { publicKey: runtimeConfig.approvalPublicKey }
              : {}),
          },
        );
        const next =
          pending.toolName === browserToolName
            ? await this.browserRunner.approve(pending.commandId, approval)
            : await this.desktopApprove(pending.commandId, approval);
        await this.recordResult(callId, next);
      } catch (error) {
        this.pending.delete(callId);
        this.emitResult(
          callId,
          {
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          },
          true,
        );
      }
      return;
    }
    this.pending.delete(callId);
    const text = JSON.stringify({
      status: result.status,
      message: result.message,
      evidence: result.evidence,
    });
    this.emitResult(
      callId,
      { content: [{ type: "text", text }] },
      result.status === "failed" || result.status === "cancelled",
    );
  }

  private async reject(callId: string): Promise<void> {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    if (pending.toolName === browserToolName) {
      await this.browserRunner.cancel(pending.commandId);
    } else {
      this.desktopSessions.delete(pending.commandId);
    }
    this.emitResult(
      callId,
      { content: [{ type: "text", text: "Rejected by user." }] },
      true,
    );
  }
  private pendingAction(pending: { commandId: string; toolName: string }): {
    action: SemanticAction;
    verifier: string;
  } {
    if (pending.toolName === browserToolName) {
      return this.browserRunner.pendingAction(pending.commandId);
    }
    const session = this.desktopSessions.get(pending.commandId);
    const step = session?.plan.steps[session.nextStepIndex];
    if (!step) throw new Error("The desktop task has no pending action.");
    return { action: step.action, verifier: step.action.verifier.type };
  }

  private async approvalDecision(
    toolName: string,
    proposal: TaskProposalSummary,
    context: { action: SemanticAction; verifier: string },
  ): Promise<HostApprovalDecision> {
    const runtimeConfig = parseRuntimeConfig(process.env);
    const riskLevel = context.action.riskLevel;
    const policy = this.deps.approvalPolicy ?? "ask";
    if (policy === "deny") return { approved: false };
    if (
      policy === "auto" &&
      runtimeConfig.environment !== "production" &&
      (riskLevel === "low" || riskLevel === "medium")
    ) {
      return {
        approved: true,
        approvedBy: this.deps.approvedBy ?? "lhic-auto-policy",
      };
    }
    if (policy === "auto") return { approved: false };
    const challenge = createActionApproval(
      context.action,
      "pending-human-approval",
    );
    return this.deps.promptApproval({
      surface: toolName === browserToolName ? "browser" : "desktop",
      actionHash: challenge.actionHash,
      riskLevel,
      intent: context.action.intent,
      verifier: context.verifier,
      toolName,
      proposal,
    });
  }

  private emitResult(
    callId: string,
    result: Record<string, unknown>,
    isError: boolean,
  ): void {
    this.deps.emitResult(callId, result, isError);
  }

  private emitUpdate(
    callId: string,
    partialResult: Record<string, unknown>,
  ): void {
    this.deps.emitUpdate(callId, partialResult);
  }
}

interface DesktopRunResult {
  status: "awaiting_approval" | "completed" | "failed" | "cancelled";
  message: string;
  evidence: string[];
  proposal: TaskProposalSummary;
}

function summarizeDesktopPlan(plan: DesktopExecutionPlan): TaskProposalSummary {
  return {
    stepCount: plan.steps.length,
    steps: plan.steps.map((step) => ({
      id: step.id,
      action: step.action.type,
      intent: step.action.intent,
      riskLevel: step.action.riskLevel,
      verifier: step.action.verifier.type,
    })),
  };
}

export function hostToolDefinitions(): Array<{
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return [
    {
      name: browserToolName,
      label: "LHIC Browser",
      description:
        "Execute a browser-plan-v1 plan with the local LHIC browser runner (visible Chromium, per-step approval, verifier evidence).",
      parameters: {
        type: "object",
        properties: { plan: { type: "object" } },
        required: ["plan"],
        additionalProperties: false,
      },
    },
    {
      name: desktopObserveToolName,
      label: "LHIC Desktop Observe",
      description:
        "Observe a consented bounded desktop scope. Returns normalized ephemeral elements and backend evidence, never a screenshot path.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["active_window", "all_windows", "application"],
          },
          application: { type: "string" },
        },
        required: ["scope"],
        additionalProperties: false,
      },
    },
    {
      name: desktopToolName,
      label: "LHIC Desktop",
      description:
        "Execute a desktop-plan-v1 plan with the local LHIC global desktop executor (every OS action requires approval and a post-action verifier).",
      parameters: {
        type: "object",
        properties: { plan: { type: "object" } },
        required: ["plan"],
        additionalProperties: false,
      },
    },
  ];
}

export function planProposalFrom(
  plan: unknown,
): TaskProposalSummary | undefined {
  if (isBrowserExecutionPlan(plan)) return summarizePlan(plan);
  if (isDesktopExecutionPlan(plan)) return summarizeDesktopPlan(plan);
  return undefined;
}
