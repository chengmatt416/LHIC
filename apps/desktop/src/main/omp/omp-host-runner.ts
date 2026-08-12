import type { TaskProposalSummary } from "../../shared/contracts.js";
import { createTaskId } from "../desktop-browser-runner.js";
import type { BrowserRunResult } from "../desktop-browser-runner.js";
import type { GlobalRunResult } from "../desktop-global-runner.js";
import type { TaskService } from "../task-service.js";

export interface HostApprovalCall {
  callId: string;
  toolName: string;
  proposal: TaskProposalSummary;
}

export interface OmpHostRunnerEmit {
  result(callId: string, result: Record<string, unknown>, isError: boolean): void;
  update(callId: string, partialResult: Record<string, unknown>): void;
}

interface PendingHostTool {
  commandId: string;
  toolName: string;
}

const browserToolName = "lhic_browser_execute";
const desktopToolName = "lhic_desktop_execute";

/**
 * Serves the omp agent's LHIC host tools. Every plan goes through the same
 * DesktopBrowserRunner / DesktopGlobalRunner gates as the native task console:
 * schema validation, per-step interactive approval, and post-action verifier
 * evidence — regardless of omp's own approval mode.
 */
export class OmpHostRunner {
  private readonly pending = new Map<string, PendingHostTool>();

  public constructor(
    private readonly tasks: TaskService,
    private readonly onApproval: (call: HostApprovalCall) => void,
    private readonly emit: OmpHostRunnerEmit,
  ) {}

  public handleHostToolCall(frame: Record<string, unknown>): void {
    if (frame.type === "host_tool_cancel") {
      this.cancel(String(frame.targetId ?? ""));
      return;
    }
    const callId = String(frame.id ?? "");
    const toolName = String(frame.toolName ?? "");
    if (!callId) return;
    const argumentsValue = frame.arguments;
    const args =
      argumentsValue && typeof argumentsValue === "object"
        ? (argumentsValue as Record<string, unknown>)
        : {};
    if (toolName !== browserToolName && toolName !== desktopToolName) {
      this.emit.result(
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
        ? this.tasks.executeOmpBrowserPlan(commandId, args.plan)
        : this.tasks.executeOmpDesktopPlan(commandId, args.plan);
    void run
      .then((result) => {
        if (!this.pending.has(callId)) return;
        this.recordResult(callId, result);
      })
      .catch((error: unknown) => {
        if (!this.pending.has(callId)) return;
        this.pending.delete(callId);
        this.emit.result(
          callId,
          {
            content: [
              {
                type: "text",
                text:
                  error instanceof Error ? error.message : String(error),
              },
            ],
          },
          true,
        );
      });
  }

  public async approve(callId: string, approvedBy: string): Promise<void> {
    const pending = this.pending.get(callId);
    if (!pending) return;
    const result =
      pending.toolName === browserToolName
        ? await this.tasks.approveOmpBrowserPlan(pending.commandId, {
            approvedBy,
          })
        : await this.tasks.approveOmpDesktopPlan(pending.commandId, {
            approvedBy,
          });
    if (!this.pending.has(callId)) return;
    this.recordResult(callId, result);
  }

  public async reject(callId: string): Promise<void> {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    if (pending.toolName === browserToolName) {
      await this.tasks.cancelOmpBrowserPlan(pending.commandId);
    } else {
      this.tasks.cancelOmpDesktopPlan(pending.commandId);
    }
    this.emit.result(
      callId,
      { content: [{ type: "text", text: "Rejected by user." }] },
      true,
    );
  }

  public cancel(callId: string): void {
    const pending = this.pending.get(callId);
    if (!pending) return;
    this.pending.delete(callId);
    if (pending.toolName === browserToolName) {
      void this.tasks.cancelOmpBrowserPlan(pending.commandId).catch(() => undefined);
    } else {
      this.tasks.cancelOmpDesktopPlan(pending.commandId);
    }
  }

  public dispose(): void {
    for (const callId of [...this.pending.keys()]) {
      this.cancel(callId);
    }
  }

  private recordResult(callId: string, result: BrowserRunResult | GlobalRunResult): void {
    const pending = this.pending.get(callId);
    if (result.status === "awaiting_approval") {
      this.onApproval({
        callId,
        toolName: pending?.toolName ?? "lhic_browser_execute",
        proposal: result.proposal,
      });
      this.emit.update(callId, {
        partialResult: {
          content: [{ type: "text", text: "Waiting for approval…" }],
        },
      });
      return;
    }
    this.pending.delete(callId);
    const text = JSON.stringify({
      status: result.status,
      message: result.message,
      evidence: result.evidence,
    });
    this.emit.result(
      callId,
      { content: [{ type: "text", text }] },
      result.status === "failed" || result.status === "cancelled",
    );
  }
}
