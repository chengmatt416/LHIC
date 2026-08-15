import type { AgentActionReceipt, SideEffectClass } from "@lhic/schema";
import { appendReceipt, hashState } from "@lhic/trace";

export interface OmpActionReceiptObserverOptions {
  taskId: string;
  sessionId?: string;
  modelId?: string;
  receiptLogPath: string;
}

export interface OmpToolLifecycleFrame {
  type: string;
  id?: unknown;
  toolId?: unknown;
  callId?: unknown;
  toolName?: unknown;
  name?: unknown;
  tool?: unknown;
  status?: unknown;
  success?: unknown;
  args?: unknown;
  taskId?: unknown;
  messageId?: unknown;
  entryId?: unknown;
  turn?: unknown;
  timestamp?: unknown;
}

const codeTools = new Set([
  "edit",
  "write",
  "apply_patch",
  "patch",
  "multi_edit",
  "read",
  "grep",
  "glob",
  "lsp",
  "debug",
  "eval",
  "bash",
]);

const shellTools = new Set(["bash", "shell", "terminal"]);

function surfaceForTool(tool: string): "code" | "shell" {
  if (shellTools.has(tool)) return "shell";
  return "code";
}

function classForTool(tool: string): SideEffectClass {
  if (shellTools.has(tool)) return "local_execute";
  if (tool === "bash") return "local_execute";
  if (tool === "read" || tool === "grep" || tool === "glob") return "read";
  return "local_edit";
}

/**
 * Observes OMP lifecycle/tool events and maps them to normalized action
 * receipts. This is an observation adapter, not a second coding harness:
 * OMP-native success is execution evidence with `executor.authority = "omp"`
 * and `verification.authority = "none"` unless an LHIC/external verifier
 * actually ran. Terminal receipts are idempotent per receipt ID, so a
 * supervisor restart never duplicates them.
 */
export class OmpActionReceiptObserver {
  private readonly pending = new Map<string, Partial<AgentActionReceipt>>();
  private writes = Promise.resolve();

  public constructor(
    private readonly options: OmpActionReceiptObserverOptions,
  ) {}

  /** Resolves when all receipt writes initiated so far have completed. */
  public flush(): Promise<void> {
    return this.writes;
  }

  public feed(frame: Record<string, unknown>): void {
    if (
      frame.type !== "tool_execution_start" &&
      frame.type !== "tool_execution_end"
    ) {
      return;
    }
    const tool = firstString(frame.toolName, frame.name, frame.tool);
    const id = firstString(frame.id, frame.toolId, frame.callId);
    if (!tool || !id) return;
    const actionId = id;
    const taskId =
      typeof frame.taskId === "string" && frame.taskId
        ? frame.taskId
        : this.options.taskId;
    const startedAt =
      typeof frame.timestamp === "string" &&
      Number.isFinite(Date.parse(frame.timestamp))
        ? frame.timestamp
        : new Date().toISOString();
    if (frame.type === "tool_execution_start") {
      const intent = intentFromArgs(frame.args);
      this.pending.set(id, {
        receiptId: this.receiptId(taskId, actionId),
        actionId,
        taskId,
        ...(this.options.sessionId
          ? { sessionId: this.options.sessionId }
          : {}),
        surface: surfaceForTool(tool),
        tool,
        ...(intent ? { intent } : {}),
        sideEffectClass: classForTool(tool),
        inferredRisk: classForTool(tool) === "local_execute" ? "medium" : "low",
        approval: {
          required: false,
          status: "not_required",
          authority: "omp",
        },
        planner: {
          authority: "omp",
          ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
        },
        executor: {
          authority: "omp",
          ...(tool === "bash" ? { backend: "omp-bash" } : { backend: "omp" }),
        },
        verification: {
          authority: "none",
          status: "not_run",
          evidenceRefs: [],
        },
        state: "dispatching",
        startedAt,
      });
      return;
    }
    const started = this.pending.get(id);
    this.pending.delete(id);
    const success = frame.success === true || frame.status === "success";
    const intent = intentFromArgs(frame.args) ?? started?.intent;
    const receipt: AgentActionReceipt = {
      schemaVersion: "lhic-action-receipt-v1",
      receiptId: this.receiptId(taskId, actionId),
      actionId,
      taskId,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      surface: surfaceForTool(tool),
      tool,
      ...(intent ? { intent } : {}),
      sideEffectClass: classForTool(tool),
      inferredRisk: classForTool(tool) === "local_execute" ? "medium" : "low",
      approval: {
        required: false,
        status: "not_required",
        authority: "omp",
      },
      planner: {
        authority: "omp",
        ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
      },
      executor: {
        authority: "omp",
        ...(tool === "bash" ? { backend: "omp-bash" } : { backend: "omp" }),
      },
      verification: { authority: "none", status: "not_run", evidenceRefs: [] },
      state: success ? "executed" : "failed",
      ...(success
        ? {}
        : { failureReason: String(frame.status ?? "tool failed") }),
      startedAt,
      completedAt: new Date().toISOString(),
    };
    this.writes = this.writes
      .catch(() => undefined)
      .then(() => appendReceipt(this.options.receiptLogPath, receipt));
  }

  /** Dedupe key: one terminal receipt per (task, tool call). */
  private receiptId(taskId: string, actionId: string): string {
    return `omp-${hashState({ taskId, actionId }).slice(0, 24)}-${actionId}`;
  }
}

function intentFromArgs(args: unknown): string | undefined {
  if (typeof args === "string") return args.slice(0, 512);
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    const candidate = firstString(
      record.command,
      record.filePath,
      record.path,
      record.file,
    );
    return candidate ? candidate.slice(0, 512) : undefined;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
