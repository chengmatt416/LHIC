import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type {
  OmpEvent,
  OmpMessageView,
  OmpModelInfo,
  OmpRuntimeState,
  OmpSessionInfo,
  OmpTodoPhase,
  OmpUiRequest,
  OmpToolCallView,
} from "../../shared/contracts.js";
import type { TaskService } from "../task-service.js";
import { resolveOmpBinary } from "./omp-binary.js";
import {
  OmpRpcClient,
  lhicHostToolDefinitions,
  type OmpRpcClientCallbacks,
} from "@lhic/omp-rpc";
import {
  OmpHostRunner,
  type HostApprovalCall,
} from "./omp-host-runner.js";

export interface OmpSessionServiceOptions {
  workspaceRoot: string;
  userDataDir: string;
  tasks: TaskService;
  openExternal?: (url: string) => Promise<void>;
  listSessionsDir?: string;
}

const stateRefreshIntervalMs = 500;

/**
 * Owns the omp `--mode rpc` child process for the desktop app: lifecycle,
 * frame-to-OmpEvent mapping, state caching, session history scanning, and
 * LHIC host-tool wiring. All model and tool execution stays inside omp or the
 * approval-gated local runners.
 */
export class OmpSessionService {
  private readonly tasks: TaskService;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly listeners = new Set<(event: OmpEvent) => void>();
  private client: OmpRpcClient | undefined;
  private hostRunner: OmpHostRunner | undefined;
  private sessionDir: string;
  private stateSnapshot: OmpRuntimeState | undefined;
  private stateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private stateRefreshPending = false;
  private anonymousMessageId = 0;
  private currentUserMessageId: string | undefined;
  private currentAssistantMessageId: string | undefined;

  public constructor(options: OmpSessionServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.tasks = options.tasks;
    this.openExternal =
      options.openExternal ?? (() => Promise.resolve());
    this.sessionDir =
      options.listSessionsDir ?? join(options.userDataDir, "omp", "sessions");
  }

  public async start(): Promise<OmpRuntimeState> {
    if (this.client) {
      return this.state();
    }
    await mkdir(this.sessionDir, { recursive: true });
    const binary = await resolveOmpBinary();
    const callbacks: OmpRpcClientCallbacks = {
      onEvent: (frame) => this.handleFrame(frame),
      onUiRequest: (frame) => {
        this.emit({ type: "ui", request: this.toUiRequest(frame) });
        if (frame.method === "open_url" && typeof frame.url === "string") {
          void this.openExternal(frame.url).catch(() => undefined);
        }
        this.scheduleStateRefresh();
      },
      onHostToolCall: (frame) => this.handleHostToolCall(frame),
      onClosed: () => {
        this.stateSnapshot = {
          running: false,
          error: "The omp agent process closed.",
          isStreaming: false,
          messageCount: 0,
          todoPhases: [],
        };
        this.emit({ type: "state", state: this.stateSnapshot });
      },
      onLog: () => undefined,
    };
    const client = new OmpRpcClient(
      {
        binary,
        workspaceRoot: this.workspaceRoot,
        sessionDir: this.sessionDir,
      },
      callbacks,
    );
    this.client = client;
    this.hostRunner = new OmpHostRunner(
      this.tasks,
      (call) => this.handleApproval(call),
      {
        result: (callId, result, isError) =>
          client.hostToolResult(callId, result, isError),
        update: (callId, partialResult) =>
          client.hostToolUpdate(callId, partialResult),
      },
    );
    await client.start();
    await client.setHostTools(lhicHostToolDefinitions());
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.hostRunner?.dispose();
    this.hostRunner = undefined;
    if (this.stateRefreshTimer) {
      clearTimeout(this.stateRefreshTimer);
      this.stateRefreshTimer = undefined;
      this.stateRefreshPending = false;
    }
    this.stateSnapshot = undefined;
    await client?.close();
  }

  public async dispose(): Promise<void> {
    await this.stop();
  }

  public subscribe(listener: (event: OmpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async state(): Promise<OmpRuntimeState> {
    if (!this.client) {
      return this.stoppedState();
    }
    if (this.stateSnapshot?.running) {
      return this.stateSnapshot;
    }
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async prompt(message: string): Promise<void> {
    await this.requireClient().prompt(message);
    await this.refreshState();
  }

  public async steer(message: string): Promise<void> {
    await this.requireClient().steer(message);
  }

  public async setThinkingLevel(
    level: OmpRuntimeState["thinkingLevel"],
  ): Promise<OmpRuntimeState> {
    if (!level) {
      throw new Error("A thinking level is required.");
    }
    await this.requireClient().setThinkingLevel(level);
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async setFastMode(enabled: boolean): Promise<OmpRuntimeState> {
    await this.requireClient().setFastMode(enabled);
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async setInterruptMode(
    mode: "immediate" | "wait",
  ): Promise<OmpRuntimeState> {
    await this.requireClient().setInterruptMode(mode);
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async renameSession(name: string): Promise<void> {
    await this.requireClient().setSessionName(name);
    await this.refreshState();
  }

  public async availableCommands(): Promise<
    Array<{ name: string; description?: string; aliases?: string[] }>
  > {
    const data = await this.requireClient().getAvailableCommands();
    const raw = Array.isArray(data.commands) ? data.commands : [];
    return raw
      .filter(
        (command): command is Record<string, unknown> =>
          Boolean(command) && typeof command === "object",
      )
      .map((command) => ({
        name: String(command.name ?? ""),
        ...(typeof command.description === "string"
          ? { description: command.description }
          : {}),
        ...(Array.isArray(command.aliases)
          ? { aliases: command.aliases.map(String) }
          : {}),
      }))
      .filter((command) => command.name);
  }

  public async messages(cursor?: string): Promise<{
    messages: OmpMessageView[];
    nextCursor?: string;
    totalMessages: number;
  }> {
    const data = await this.requireClient().getMessagesPage(cursor);
    const raw = Array.isArray(data.messages) ? data.messages : [];
    return {
      messages: raw
        .filter(
          (message): message is Record<string, unknown> =>
            Boolean(message) && typeof message === "object",
        )
        .map((message) => ({
          id: String(message.id ?? this.nextAnonymousMessageId()),
          role: message.role === "user" ? ("user" as const) : ("assistant" as const),
          text: this.contentText(message),
          status: "complete" as const,
          toolCalls: this.contentToolCalls(message),
        })),
      ...(typeof data.nextCursor === "string"
        ? { nextCursor: data.nextCursor }
        : {}),
      totalMessages: Number(data.totalMessages ?? raw.length),
    };
  }

  public async followUp(message: string): Promise<void> {
    await this.requireClient().followUp(message);
  }

  public async abort(): Promise<void> {
    await this.requireClient().abort();
    await this.refreshState();
  }

  public async newSession(): Promise<OmpRuntimeState> {
    await this.requireClient().newSession();
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async switchSession(path: string): Promise<OmpRuntimeState> {
    await this.requireClient().switchSession(path);
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async setModel(
    provider: string,
    modelId: string,
  ): Promise<OmpRuntimeState> {
    await this.requireClient().setModel(provider, modelId);
    await this.refreshState();
    return this.stateSnapshot ?? this.stoppedState();
  }

  public async setTodos(phases: OmpTodoPhase[]): Promise<void> {
    await this.requireClient().setTodos(
      phases.map((phase) => ({
        id: phase.id,
        name: phase.name,
        tasks: phase.tasks.map((task) => ({
          id: task.id,
          content: task.content,
          status: task.status,
        })),
      })),
    );
    await this.refreshState();
  }

  public async exportHtml(): Promise<string> {
    const outputPath = join(
      this.workspaceRoot,
      ".lhic",
      `omp-export-${Date.now()}.html`,
    );
    await this.requireClient().exportHtml(outputPath);
    return outputPath;
  }

  public async listModels(): Promise<OmpModelInfo[]> {
    const data = await this.requireClient().getAvailableModels();
    const raw = Array.isArray(data.models) ? data.models : [];
    return raw
      .filter(
        (model): model is Record<string, unknown> =>
          Boolean(model) && typeof model === "object",
      )
      .map((model) => ({
        provider: String(model.provider ?? ""),
        id: String(model.modelId ?? model.id ?? ""),
      }))
      .filter((model) => model.provider && model.id);
  }

  public async loginProviders(): Promise<Array<{ id: string }>> {
    const data = await this.requireClient().getLoginProviders();
    const raw = Array.isArray(data.providers) ? data.providers : [];
    return raw
      .filter(
        (provider): provider is Record<string, unknown> =>
          Boolean(provider) && typeof provider === "object",
      )
      .map((provider) => ({ id: String(provider.id ?? "") }))
      .filter((provider) => provider.id);
  }

  public async login(providerId: string): Promise<void> {
    await this.requireClient().login(providerId);
  }

  public respondUi(
    requestId: string,
    response: {
      value?: string;
      confirmed?: boolean;
      cancelled?: boolean;
    },
  ): Promise<void> {
    return this.requireClient().uiResponse(requestId, response);
  }

  public approveHostTool(callId: string, approvedBy: string): Promise<void> {
    return this.hostRunner?.approve(callId, approvedBy) ?? Promise.resolve();
  }

  public rejectHostTool(callId: string): Promise<void> {
    return this.hostRunner?.reject(callId) ?? Promise.resolve();
  }

  public async listSessions(): Promise<OmpSessionInfo[]> {
    let files: string[];
    try {
      files = await readdir(this.sessionDir ?? "");
    } catch {
      return [];
    }
    const sessions: OmpSessionInfo[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = resolve(this.sessionDir ?? "", file);
      sessions.push(await this.sessionInfo(path));
    }
    return sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  private async sessionInfo(path: string): Promise<OmpSessionInfo> {
    let name = basename(path, ".jsonl");
    let messageCount = 0;
    let updatedAt = "";
    try {
      const text = await readFile(path, "utf8");
      messageCount = text ? text.split("\n").length : 0;
      const firstLine = text.split("\n", 1)[0] ?? "";
      if (firstLine.trim()) {
        const record = JSON.parse(firstLine) as Record<string, unknown>;
        const title =
          typeof record.title === "string"
            ? record.title
            : typeof record.name === "string"
              ? record.name
              : undefined;
        if (title?.trim()) {
          name = title.trim();
        }
      }
      updatedAt = (await stat(path)).mtime.toISOString();
    } catch {
      updatedAt = new Date().toISOString();
    }
    return { path, name, messageCount, updatedAt };
  }

  private handleFrame(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case "agent_start":
        this.emit({ type: "agent", phase: "start" });
        break;
      case "agent_end":
        this.emit({ type: "agent", phase: "end" });
        break;
      case "message_start": {
        const role = this.messageRole(frame);
        const id = this.resolveMessageId(frame, role, true);
        const message = this.toMessageView(frame, role === "user" ? "complete" : "streaming", id);
        if (message) this.emit({ type: "message", message });
        break;
      }
      case "message_end": {
        const role = this.messageRole(frame);
        const id = this.resolveMessageId(frame, role, false);
        const message = this.toMessageView(frame, "complete", id);
        if (message) this.emit({ type: "message", message });
        break;
      }
      case "message_update": {
        const delta = this.deltaFrom(frame);
        if (delta) {
          this.emit({ type: "delta", messageId: delta.messageId, text: delta.text });
          break;
        }
        const id = this.resolveMessageId(frame, "assistant", false);
        const message = this.toMessageView(frame, "streaming", id);
        if (message) this.emit({ type: "message", message });
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.emitToolEvent(frame);
        break;
      case "available_commands_update": {
        const raw = Array.isArray(frame.commands) ? frame.commands : [];
        const commands = raw
          .filter(
            (command): command is Record<string, unknown> =>
              Boolean(command) && typeof command === "object",
          )
          .map((command) => ({
            name: String(command.name ?? ""),
            ...(typeof command.description === "string"
              ? { description: command.description }
              : {}),
            ...(Array.isArray(command.aliases)
              ? { aliases: command.aliases.map(String) }
              : {}),
          }))
          .filter((command) => command.name);
        this.emit({ type: "commands", commands });
        break;
      }
      case "extension_error":
        this.emit({
          type: "error",
          message: String(frame.error ?? "The omp agent reported an extension error."),
        });
        break;
      default:
        break;
    }
    this.scheduleStateRefresh();
  }

  private handleHostToolCall(frame: Record<string, unknown>): void {
    if (frame.type === "host_tool_cancel") {
      this.hostRunner?.cancel(String(frame.targetId ?? ""));
      return;
    }
    const call = {
      id: String(frame.id ?? ""),
      toolName: String(frame.toolName ?? ""),
      arguments:
        frame.arguments && typeof frame.arguments === "object"
          ? (frame.arguments as Record<string, unknown>)
          : {},
    };
    this.emit({ type: "host-tool", call });
    this.hostRunner?.handleHostToolCall(frame);
    this.scheduleStateRefresh();
  }

  private handleApproval(call: HostApprovalCall): void {
    this.emit({
      type: "host-tool",
      call: {
        id: call.callId,
        toolName: call.toolName,
        arguments: {},
        proposal: call.proposal,
      },
    });
  }

  private deltaFrom(frame: Record<string, unknown>): { messageId: string; text: string } | undefined {
    const assistantEvent = frame.assistantMessageEvent as
      | Record<string, unknown>
      | undefined;
    if (
      !assistantEvent ||
      assistantEvent.type !== "text_delta" ||
      typeof assistantEvent.delta !== "string"
    ) {
      return undefined;
    }
    return {
      messageId: this.resolveMessageId(frame, "assistant", false),
      text: assistantEvent.delta,
    };
  }

  private messageRole(frame: Record<string, unknown>): "user" | "assistant" {
    const message = frame.message as Record<string, unknown> | undefined;
    return message?.role === "user" ? "user" : "assistant";
  }

  private explicitMessageId(
    frame: Record<string, unknown>,
  ): string | undefined {
    const message = frame.message as Record<string, unknown> | undefined;
    if (message && typeof message.id === "string" && message.id) {
      return message.id;
    }
    if (typeof frame.messageId === "string" && frame.messageId) {
      return frame.messageId;
    }
    return undefined;
  }

  /**
   * omp message frames carry no stable id on the wire, so each turn gets one
   * generated identity per role: message_start opens it, later frames for the
   * same role continue it, and deltas append to it. Explicit ids (when the
   * runtime supplies them) always win.
   */
  private resolveMessageId(
    frame: Record<string, unknown>,
    role: "user" | "assistant",
    advancing: boolean,
  ): string {
    const explicit = this.explicitMessageId(frame);
    if (explicit) {
      if (role === "user") {
        this.currentUserMessageId = explicit;
      } else {
        this.currentAssistantMessageId = explicit;
      }
      return explicit;
    }
    const current =
      role === "user" ? this.currentUserMessageId : this.currentAssistantMessageId;
    if (!advancing && current) {
      return current;
    }
    const id = this.nextAnonymousMessageId();
    if (role === "user") {
      this.currentUserMessageId = id;
    } else {
      this.currentAssistantMessageId = id;
    }
    return id;
  }

  private toMessageView(
    frame: Record<string, unknown>,
    status: OmpMessageView["status"],
    id: string,
  ): OmpMessageView | undefined {
    const message = frame.message;
    if (!message || typeof message !== "object") {
      return undefined;
    }
    const record = message as Record<string, unknown>;
    return {
      id,
      role: record.role === "user" ? "user" : "assistant",
      text: this.contentText(record),
      status,
      toolCalls: this.contentToolCalls(record),
    };
  }

  private contentText(message: Record<string, unknown>): string {
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
      .filter((item) => item.type === "text")
      .map((item) => String(item.text ?? ""))
      .join("");
  }

  private contentToolCalls(message: Record<string, unknown>): OmpToolCallView[] {
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
      .filter(
        (item) => item.type === "toolCall" || item.type === "tool_use",
      )
      .map((item) => ({
        id: String(item.id ?? ""),
        name: String(item.name ?? ""),
        state: "running" as const,
      }));
  }

  private emitToolEvent(frame: Record<string, unknown>): void {
    const tool = frame.tool as Record<string, unknown> | undefined;
    const id = String(
      (tool && typeof tool.id === "string" ? tool.id : "") ||
        frame.toolCallId ||
        "",
    );
    const name = String(
      (tool && typeof tool.name === "string" ? tool.name : "") ||
        frame.toolName ||
        "",
    );
    if (!id) return;
    const result = frame.result as Record<string, unknown> | undefined;
    const failed =
      Boolean(frame.error) ||
      Boolean(result && (result.error || result.failed === true));
    const state = frame.type === "tool_execution_end"
      ? failed
        ? ("error" as const)
        : ("success" as const)
      : ("running" as const);
    const summary = this.toolSummary(frame);
    this.emit({ type: "tool", tool: { id, name, state, ...(summary ? { summary } : {}) } });
  }

  private toolSummary(frame: Record<string, unknown>): string | undefined {
    const result = frame.result as Record<string, unknown> | undefined;
    const candidates = [
      frame.error,
      result?.summary,
      result?.message,
      frame.detail,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.slice(0, 500);
      }
    }
    return undefined;
  }

  private toUiRequest(frame: Record<string, unknown>): OmpUiRequest {
    const method = String(frame.method ?? "notify");
    return {
      id: String(frame.id ?? ""),
      method: ["confirm", "input", "select", "editor", "notify"].includes(method)
        ? (method as OmpUiRequest["method"])
        : "notify",
      ...(typeof frame.title === "string" ? { title: frame.title } : {}),
      ...(typeof frame.message === "string" ? { message: frame.message } : {}),
      ...(typeof frame.placeholder === "string"
        ? { placeholder: frame.placeholder }
        : {}),
      ...(typeof frame.timeout === "number" ? { timeout: frame.timeout } : {}),
    };
  }

  private scheduleStateRefresh(): void {
    if (this.stateRefreshPending || !this.client) return;
    this.stateRefreshPending = true;
    this.stateRefreshTimer = setTimeout(() => {
      this.stateRefreshPending = false;
      this.stateRefreshTimer = undefined;
      void this.refreshState().catch(() => undefined);
    }, stateRefreshIntervalMs);
  }

  private async refreshState(): Promise<void> {
    if (!this.client) return;
    const data = await this.client.getState();
    const state = this.toRuntimeState(data, true);
    this.stateSnapshot = state;
    this.emit({ type: "state", state });
  }

  private toRuntimeState(
    data: Record<string, unknown>,
    running: boolean,
    error?: string,
  ): OmpRuntimeState {
    const model = data.model as Record<string, unknown> | undefined;
    const todoPhases = Array.isArray(data.todoPhases)
      ? data.todoPhases
          .filter(
            (phase): phase is Record<string, unknown> =>
              Boolean(phase) && typeof phase === "object",
          )
          .map((phase) => ({
            id: String(phase.id ?? ""),
            name: String(phase.name ?? ""),
            tasks: Array.isArray(phase.tasks)
              ? phase.tasks
                  .filter(
                    (task): task is Record<string, unknown> =>
                      Boolean(task) && typeof task === "object",
                  )
                  .map((task) => ({
                    id: String(task.id ?? ""),
                    content: String(task.content ?? ""),
                    status:
                      task.status === "in_progress" || task.status === "completed"
                        ? (task.status as OmpTodoPhase["tasks"][number]["status"])
                        : ("pending" as const),
                  }))
              : [],
          }))
      : [];
    const contextUsage = data.contextUsage as Record<string, unknown> | undefined;
    const state: OmpRuntimeState = {
      running,
      isStreaming: data.isStreaming === true,
      messageCount: Number(data.messageCount ?? 0),
      todoPhases,
    };
    if (error) state.error = error;
    if (model && typeof model.provider === "string" && typeof model.id === "string") {
      state.model = { provider: model.provider, id: model.id };
    }
    const thinkingLevel = data.thinkingLevel;
    const sessionName = data.sessionName;
    const sessionFile = data.sessionFile;
    if (typeof thinkingLevel === "string") {
      state.thinkingLevel = thinkingLevel as NonNullable<
        OmpRuntimeState["thinkingLevel"]
      >;
    }
    if (typeof sessionName === "string") {
      state.sessionName = sessionName;
    }
    if (typeof sessionFile === "string") {
      state.sessionFile = sessionFile;
    }
    if (typeof data.fastModeEnabled === "boolean") {
      state.fastModeEnabled = data.fastModeEnabled;
    }
    if (typeof data.fastModeActive === "boolean") {
      state.fastModeActive = data.fastModeActive;
    }
    if (data.interruptMode === "immediate" || data.interruptMode === "wait") {
      state.interruptMode = data.interruptMode;
    }
    if (contextUsage) {
      state.contextUsage = {
        tokens: Number(contextUsage.tokens ?? 0),
        contextWindow: Number(contextUsage.contextWindow ?? 0),
        percent: Number(contextUsage.percent ?? 0),
      };
    }
    return state;
  }

  private nextAnonymousMessageId(): string {
    this.anonymousMessageId += 1;
    return `message-${this.anonymousMessageId}`;
  }

  private stoppedState(): OmpRuntimeState {
    return {
      running: false,
      isStreaming: false,
      messageCount: 0,
      todoPhases: [],
    };
  }

  private requireClient(): OmpRpcClient {
    const client = this.client;
    if (!client) {
      throw new Error("The omp agent is not running.");
    }
    return client;
  }

  private emit(event: OmpEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private readonly workspaceRoot: string;
}
