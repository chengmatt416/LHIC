import { join, resolve } from "node:path";

import {
  isBrowserExecutionPlan,
  isDesktopExecutionPlan,
  type DesktopExecutionPlan,
} from "@lhic/schema";
import { parseRuntimeConfig } from "@lhic/security";
import { GlobalComputerExecutor } from "@lhic/skills";

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
    toolName: string,
    proposal: TaskProposalSummary,
  ) => Promise<{ approved: boolean; approvedBy: string }>;
  emitResult: (
    callId: string,
    result: Record<string, unknown>,
    isError: boolean,
  ) => void;
  emitUpdate: (callId: string, partialResult: Record<string, unknown>) => void;
}

const browserToolName = "lhic_browser_execute";
const desktopToolName = "lhic_desktop_execute";

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
    if (toolName !== browserToolName && toolName !== desktopToolName) {
      this.emitResult(
        callId,
        { content: [{ type: "text", text: `Unsupported host tool: ${toolName}` }] },
        true,
      );
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

  private desktopExecute(
    commandId: string,
    plan: DesktopExecutionPlan,
  ): Promise<DesktopRunResult> {
    if (!isDesktopExecutionPlan(plan)) {
      return Promise.reject(
        new Error("Desktop execution requires a valid desktop-plan-v1 proposal."),
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
    approvedBy: string,
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
      traceFilePath: join(
        runtimeConfig.traceDirectory,
        `${commandId}.jsonl`,
      ),
      approvalValidation: {
        requireSignature: runtimeConfig.environment === "production",
        ...(runtimeConfig.approvalPublicKey
          ? { publicKey: runtimeConfig.approvalPublicKey }
          : {}),
      },
    });
    const execution = await executor.execute(step.action, {
      approvedBy,
    } as never);
    if (!execution.success) {
      return this.desktopFailure(commandId, execution.error ?? "Desktop action failed.");
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
        partialResult: { content: [{ type: "text", text: "Waiting for approval…" }] },
      });
      const decision = await this.deps.promptApproval(
        this.pending.get(callId)?.toolName ?? browserToolName,
        result.proposal,
      );
      const pending = this.pending.get(callId);
      if (!pending) return;
      if (!decision.approved) {
        await this.reject(callId);
        return;
      }
      try {
        const next =
          pending.toolName === browserToolName
            ? await this.browserRunner.approve(
                pending.commandId,
                { approvedBy: decision.approvedBy } as never,
              )
            : await this.desktopApprove(pending.commandId, decision.approvedBy);
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

  private emitResult(
    callId: string,
    result: Record<string, unknown>,
    isError: boolean,
  ): void {
    this.deps.emitResult(callId, result, isError);
  }

  private emitUpdate(callId: string, partialResult: Record<string, unknown>): void {
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

export function planProposalFrom(plan: unknown): TaskProposalSummary | undefined {
  if (isBrowserExecutionPlan(plan)) return summarizePlan(plan);
  if (isDesktopExecutionPlan(plan)) return summarizeDesktopPlan(plan);
  return undefined;
}
