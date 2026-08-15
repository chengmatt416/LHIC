import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type {
  OmpAdvancedCommand,
  OmpEvent,
  OmpMessageView,
  OmpModelInfo,
  OmpProviderKeyStatus,
  OmpRuntimeState,
  OmpSessionInfo,
  OmpSessionStats,
  OmpSubagentView,
  OmpSubagentModel,
  OmpTodoPhase,
  OmpUiRequest,
  OmpToolCallView,
} from "../../shared/contracts.js";
import type { TaskService } from "../task-service.js";
import { resolveOmpBinary } from "./omp-binary.js";
import {
  OmpRpcSupervisor,
  lhicHostToolDefinitions,
  SubagentModelPool,
  connectedSelectors,
  parseModelCatalog,
  type OmpModelCatalogEntry,
  type OmpRpcClientCallbacks,
} from "@lhic/omp-rpc";
import { OmpHostRunner, type HostApprovalCall } from "./omp-host-runner.js";
import { OmpProviderKeyStore } from "./provider-key-store.js";

export interface OmpSessionServiceOptions {
  workspaceRoot: string;
  userDataDir: string;
  tasks: TaskService;
  openExternal?: (url: string) => Promise<void>;
  listSessionsDir?: string;
  providerKeys?: OmpProviderKeyStore;
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
  private readonly providerKeys: OmpProviderKeyStore;
  private readonly listeners = new Set<(event: OmpEvent) => void>();
  private client: OmpRpcSupervisor | undefined;
  private hostRunner: OmpHostRunner | undefined;
  private sessionDir: string;
  private readonly recoveryStateDir: string;
  private readonly modelPool: SubagentModelPool;
  private readonly modelPoolStatePath: string;
  private modelCatalog: OmpModelCatalogEntry[] = [];
  private enabledSubagentSelectors: string[] = [];
  private enabledSubagentModels = new Map<
    string,
    { provider: string; model: string }
  >();
  private stateSnapshot: OmpRuntimeState | undefined;
  private stateRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private stateRefreshPending = false;
  private anonymousMessageId = 0;
  private currentUserMessageId: string | undefined;
  private currentAssistantMessageId: string | undefined;

  public constructor(options: OmpSessionServiceOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.tasks = options.tasks;
    this.openExternal = options.openExternal ?? (() => Promise.resolve());
    this.sessionDir =
      options.listSessionsDir ?? join(options.userDataDir, "omp", "sessions");
    this.recoveryStateDir = join(options.userDataDir, "omp", "recovery");
    const modelPoolRoot = join(options.userDataDir, "omp", "model-pool");
    this.modelPool = new SubagentModelPool(modelPoolRoot);
    this.modelPoolStatePath = join(
      options.userDataDir,
      "omp",
      "subagent-models.json",
    );
    this.providerKeys =
      options.providerKeys ??
      new OmpProviderKeyStore(undefined, options.userDataDir);
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
      onClosed: (error) => {
        if (this.client === client) {
          this.client = undefined;
          this.hostRunner?.dispose();
          this.hostRunner = undefined;
        }
        this.stateSnapshot = {
          running: false,
          error: error?.message ?? "The omp agent process closed.",
          isStreaming: false,
          messageCount: 0,
          todoPhases: [],
        };
        this.emit({ type: "state", state: this.stateSnapshot });
      },
      onLog: () => undefined,
    };
    const client = new OmpRpcSupervisor(
      {
        binary,
        workspaceRoot: this.workspaceRoot,
        sessionDir: this.sessionDir,
        stateDirectory: this.recoveryStateDir,
        env: await this.providerKeys.buildOmpEnv(),
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
    try {
      await client.start();
      await client.setHostTools(lhicHostToolDefinitions());
      await client.setSubagentSubscription("events");
      await this.initializeModelPool(client);
      await this.refreshState();
      return this.stateSnapshot ?? this.stoppedState();
    } catch (error) {
      if (this.client === client) {
        this.client = undefined;
        this.hostRunner?.dispose();
        this.hostRunner = undefined;
      }
      await client.close().catch(() => undefined);
      throw error;
    }
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
          role:
            message.role === "user"
              ? ("user" as const)
              : ("assistant" as const),
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
    const outputDirectory = join(this.workspaceRoot, ".lhic");
    await mkdir(outputDirectory, { recursive: true });
    const outputPath = join(outputDirectory, `omp-export-${Date.now()}.html`);
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

  public async listSubagentModels(): Promise<OmpSubagentModel[]> {
    if (this.modelCatalog.length === 0) {
      this.modelCatalog = parseModelCatalog(
        await this.requireClient().getAvailableModels(),
      );
    }
    return this.toSubagentModels();
  }

  public async setSubagentModels(
    selectors: string[],
  ): Promise<OmpSubagentModel[]> {
    if (this.stateSnapshot?.isStreaming) {
      throw new Error(
        "Cannot change the subagent model pool while an agent turn is active.",
      );
    }
    const client = this.requireClient();
    this.modelCatalog = parseModelCatalog(await client.getAvailableModels());
    const generated = await this.modelPool.generate(
      this.modelCatalog,
      selectors,
    );
    await client.restartWithExtensionRoots(
      generated.models.length > 0 ? [generated.extensionRoot] : [],
    );
    this.enabledSubagentModels = new Map(
      generated.models.map((model) => [
        model.agentName,
        { provider: model.provider, model: model.modelId },
      ]),
    );
    this.enabledSubagentSelectors = generated.models.map(
      (model) => model.selector,
    );
    await this.writeSubagentSelectors(this.enabledSubagentSelectors);
    await this.refreshState();
    return this.toSubagentModels();
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

  public async providerKeyStatus(): Promise<OmpProviderKeyStatus[]> {
    return this.providerKeys.status();
  }

  /**
   * Stores a provider API key and restarts the agent so omp picks it up from
   * its environment. Used both for first-run setup (omp refuses to start
   * without a model) and for switching providers.
   */
  public async setProviderKey(
    provider: string,
    key: string,
  ): Promise<OmpRuntimeState> {
    await this.providerKeys.setKey(provider, key);
    return this.restartAgent();
  }

  public async removeProviderKey(provider: string): Promise<OmpRuntimeState> {
    await this.providerKeys.removeKey(provider);
    return this.restartAgent();
  }

  private async restartAgent(): Promise<OmpRuntimeState> {
    const wasRunning = Boolean(this.client);
    if (wasRunning) {
      await this.stop();
    }
    const started = await this.start();
    if (!wasRunning && !started.running) {
      return started;
    }
    return started;
  }

  public async sessionStats(): Promise<OmpSessionStats> {
    const raw = await this.requireClient().getSessionStats();
    return {
      ...(typeof raw.inputTokens === "number"
        ? { inputTokens: raw.inputTokens }
        : {}),
      ...(typeof raw.outputTokens === "number"
        ? { outputTokens: raw.outputTokens }
        : {}),
      ...(typeof raw.totalTokens === "number"
        ? { totalTokens: raw.totalTokens }
        : {}),
      ...(typeof raw.cost === "number" ? { cost: raw.cost } : {}),
      ...(typeof raw.turns === "number" ? { turns: raw.turns } : {}),
      ...(typeof raw.durationMs === "number"
        ? { durationMs: raw.durationMs }
        : {}),
      raw,
    };
  }

  public advanced(input: OmpAdvancedCommand): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    switch (input.command) {
      case "abortAndPrompt":
        return client.abortAndPrompt(requiredValue(input.message, "message"));
      case "cycleModel":
        return client.cycleModel();
      case "cycleThinkingLevel":
        return client.cycleThinkingLevel();
      case "compact":
        return client.compact(input.message);
      case "setAutoCompaction":
        return client.setAutoCompaction(input.enabled === true);
      case "setAutoRetry":
        return client.setAutoRetry(input.enabled === true);
      case "abortRetry":
        return client.abortRetry();
      case "bash":
        return client.bash(requiredValue(input.message, "command"));
      case "abortBash":
        return client.abortBash();
      case "setSteeringMode":
        return client.setSteeringMode(input.mode ?? "one-at-a-time");
      case "setFollowUpMode":
        return client.setFollowUpMode(input.mode ?? "one-at-a-time");
      case "branch":
        return client.branch(requiredValue(input.entryId, "entry id"));
      case "getBranchMessages":
        return client.getBranchMessages();
      case "getLastAssistantText":
        return client.getLastAssistantText();
      case "handoff":
        return client.handoff(input.message);
      case "setSubagentSubscription":
        return client.setSubagentSubscription(input.subscription ?? "events");
      case "getSubagentMessages":
        return client.getSubagentMessages({
          ...(input.subagentId ? { subagentId: input.subagentId } : {}),
          ...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
          ...(input.fromByte !== undefined ? { fromByte: input.fromByte } : {}),
        });
    }
  }

  public async subagents(): Promise<OmpSubagentView[]> {
    const data = await this.requireClient().getSubagents();
    return mapSubagents(data, this.enabledSubagentModelsByAgent());
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
      const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
      messageCount = lines.length;
      const firstLine = lines[0] ?? "";
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
      case "rpc_recovery": {
        const recoveryState = String(frame.state);
        if (
          recoveryState === "running" ||
          recoveryState === "restarting" ||
          recoveryState === "resumed" ||
          recoveryState === "recovery_failed"
        ) {
          this.stateSnapshot = {
            ...(this.stateSnapshot ?? this.stoppedState()),
            running: recoveryState !== "recovery_failed",
            isStreaming:
              recoveryState === "restarting"
                ? false
                : (this.stateSnapshot?.isStreaming ?? false),
            recoveryState,
            ...(recoveryState === "recovery_failed"
              ? {
                  error: String(
                    frame.error ?? "The omp agent could not be recovered.",
                  ),
                }
              : {}),
          };
          this.emit({ type: "state", state: this.stateSnapshot });
        }
        break;
      }
      case "agent_start":
        this.emit({ type: "agent", phase: "start" });
        break;
      case "agent_end":
        this.emit({ type: "agent", phase: "end" });
        break;
      case "message_start": {
        const role = this.messageRole(frame);
        const id = this.resolveMessageId(frame, role, true);
        const message = this.toMessageView(
          frame,
          role === "user" ? "complete" : "streaming",
          id,
        );
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
      case "subagent_lifecycle":
      case "subagent_progress":
      case "subagent_event": {
        const subagent = mapSubagentFrame(
          frame,
          this.enabledSubagentModelsByAgent(),
        );
        if (subagent) {
          this.emit({
            type: "subagents",
            subagents: [subagent],
          });
        }
        break;
      }
      case "message_update": {
        const delta = this.deltaFrom(frame);
        if (delta) {
          this.emit({
            type: "delta",
            messageId: delta.messageId,
            text: delta.text,
          });
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
          message: String(
            frame.error ?? "The omp agent reported an extension error.",
          ),
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

  private deltaFrom(
    frame: Record<string, unknown>,
  ): { messageId: string; text: string } | undefined {
    const assistantEvent = frame.assistantMessageEvent as
      Record<string, unknown> | undefined;
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
      role === "user"
        ? this.currentUserMessageId
        : this.currentAssistantMessageId;
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

  private contentToolCalls(
    message: Record<string, unknown>,
  ): OmpToolCallView[] {
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object",
      )
      .filter((item) => item.type === "toolCall" || item.type === "tool_use")
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
    const state =
      frame.type === "tool_execution_end"
        ? failed
          ? ("error" as const)
          : ("success" as const)
        : ("running" as const);
    const summary = this.toolSummary(frame);
    const provenance = this.toolProvenance(frame);
    this.emit({
      type: "tool",
      tool: {
        id,
        name,
        state,
        ...(summary ? { summary } : {}),
        ...(provenance ? { provenance } : {}),
      },
    });
  }

  /**
   * Truthful provenance for tool frames: OMP tools are executed by omp and
   * never labeled LHIC-verified unless a verifier actually ran and produced
   * evidence (LHIC host-tool results carry their own receipts).
   */
  private toolProvenance(
    frame: Record<string, unknown>,
  ): { executor: string; verifier: string; evidenceRefs: number } | undefined {
    const result = frame.result as Record<string, unknown> | undefined;
    if (result?.evidence && Array.isArray(result.evidence)) {
      return {
        executor: "lhic",
        verifier: "lhic",
        evidenceRefs: result.evidence.length,
      };
    }
    if (frame.type === "tool_execution_end") {
      return { executor: "omp", verifier: "none", evidenceRefs: 0 };
    }
    return undefined;
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
      method: [
        "confirm",
        "input",
        "select",
        "editor",
        "notify",
        "open_url",
      ].includes(method)
        ? (method as OmpUiRequest["method"])
        : "notify",
      ...(typeof frame.title === "string" ? { title: frame.title } : {}),
      ...(typeof frame.message === "string" ? { message: frame.message } : {}),
      ...(typeof frame.placeholder === "string"
        ? { placeholder: frame.placeholder }
        : {}),
      ...(typeof frame.timeout === "number" ? { timeout: frame.timeout } : {}),
      ...(typeof frame.url === "string" ? { url: frame.url } : {}),
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
    if (this.stateSnapshot?.recoveryState) {
      state.recoveryState = this.stateSnapshot.recoveryState;
    }
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
                      task.status === "in_progress" ||
                      task.status === "completed"
                        ? (task.status as OmpTodoPhase["tasks"][number]["status"])
                        : ("pending" as const),
                  }))
              : [],
          }))
      : [];
    const contextUsage = data.contextUsage as
      Record<string, unknown> | undefined;
    const state: OmpRuntimeState = {
      running,
      isStreaming: data.isStreaming === true,
      messageCount: Number(data.messageCount ?? 0),
      todoPhases,
    };
    if (error) state.error = error;
    if (
      model &&
      typeof model.provider === "string" &&
      typeof model.id === "string"
    ) {
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
    if (data.steeringMode === "all" || data.steeringMode === "one-at-a-time") {
      state.steeringMode = data.steeringMode;
    }
    if (data.followUpMode === "all" || data.followUpMode === "one-at-a-time") {
      state.followUpMode = data.followUpMode;
    }
    if (typeof data.autoCompactionEnabled === "boolean") {
      state.autoCompactionEnabled = data.autoCompactionEnabled;
    }
    if (typeof data.autoRetryEnabled === "boolean") {
      state.autoRetryEnabled = data.autoRetryEnabled;
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

  private async initializeModelPool(client: OmpRpcSupervisor): Promise<void> {
    this.modelCatalog = parseModelCatalog(await client.getAvailableModels());
    const saved = await this.readSubagentSelectors();
    const effective = connectedSelectors(this.modelCatalog, saved);
    const generated = await this.modelPool.generate(
      this.modelCatalog,
      effective,
    );
    this.enabledSubagentSelectors = effective;
    this.enabledSubagentModels = new Map(
      generated.models.map((model) => [
        model.agentName,
        { provider: model.provider, model: model.modelId },
      ]),
    );
    if (generated.models.length > 0) {
      await client.restartWithExtensionRoots([generated.extensionRoot]);
    }
    if (!sameStrings(saved, effective)) {
      await this.writeSubagentSelectors(effective);
    }
  }

  private toSubagentModels(): OmpSubagentModel[] {
    const enabled = new Set(this.enabledSubagentSelectors);
    return this.modelCatalog.map((model) => {
      const selector = `${model.provider}/${model.id}`;
      return {
        selector,
        provider: model.provider,
        modelId: model.id,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        enabled: enabled.has(selector),
        connected: true,
        ...(model.reasoning !== undefined
          ? { reasoning: model.reasoning }
          : {}),
        ...(model.image !== undefined ? { image: model.image } : {}),
        ...(model.contextWindow !== undefined
          ? { contextWindow: model.contextWindow }
          : {}),
        ...(model.thinkingLevels
          ? { thinkingLevels: [...model.thinkingLevels] }
          : {}),
      };
    });
  }

  private enabledSubagentModelsByAgent(): Map<
    string,
    { provider: string; model: string }
  > {
    return this.enabledSubagentModels;
  }

  private async readSubagentSelectors(): Promise<string[]> {
    try {
      const data = JSON.parse(
        await readFile(this.modelPoolStatePath, "utf8"),
      ) as unknown;
      if (!data || typeof data !== "object" || Array.isArray(data)) return [];
      const selectors = (data as Record<string, unknown>).selectors;
      return Array.isArray(selectors)
        ? selectors.filter(
            (selector): selector is string => typeof selector === "string",
          )
        : [];
    } catch {
      return [];
    }
  }

  private async writeSubagentSelectors(selectors: string[]): Promise<void> {
    await mkdir(dirname(this.modelPoolStatePath), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.modelPoolStatePath}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          schemaVersion: "lhic-omp-subagent-models-v1",
          selectors,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, this.modelPoolStatePath);
  }

  private stoppedState(): OmpRuntimeState {
    return {
      running: false,
      isStreaming: false,
      messageCount: 0,
      todoPhases: [],
    };
  }

  private requireClient(): OmpRpcSupervisor {
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

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requiredValue(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`OMP ${label} is required.`);
  return value;
}

function mapSubagents(
  data: Record<string, unknown>,
  models: Map<string, { provider: string; model: string }>,
): OmpSubagentView[] {
  const raw = Array.isArray(data.subagents) ? data.subagents : [];
  return raw
    .filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object",
    )
    .map((value) => mapSubagent(value, models))
    .filter((value): value is OmpSubagentView => value !== undefined);
}

function mapSubagentFrame(
  frame: Record<string, unknown>,
  models: Map<string, { provider: string; model: string }>,
): OmpSubagentView | undefined {
  const payload =
    frame.payload &&
    typeof frame.payload === "object" &&
    !Array.isArray(frame.payload)
      ? (frame.payload as Record<string, unknown>)
      : frame;
  return mapSubagent(payload, models);
}

function mapSubagent(
  value: Record<string, unknown>,
  models: Map<string, { provider: string; model: string }>,
): OmpSubagentView | undefined {
  const progress =
    value.progress &&
    typeof value.progress === "object" &&
    !Array.isArray(value.progress)
      ? (value.progress as Record<string, unknown>)
      : {};
  const id = String(value.id ?? value.subagentId ?? progress.id ?? "");
  if (!id) return undefined;
  const agent = String(value.agent ?? value.label ?? "Subagent");
  const selector = models.get(agent);
  const startedAt = timestampValue(
    value.startedAt ?? progress.startedAt ?? value.lastUpdate,
  );
  return {
    id,
    label: agent,
    task: String(value.task ?? value.assignment ?? value.description ?? ""),
    status: String(
      progress.status ??
        (value.status === "started" ? "running" : value.status) ??
        value.phase ??
        "running",
    ),
    ...(selector ? { provider: selector.provider, model: selector.model } : {}),
    ...(typeof progress.progress === "string"
      ? { progress: progress.progress }
      : typeof value.progress === "string"
        ? { progress: value.progress }
        : {}),
    ...(startedAt ? { startedAt } : {}),
  };
}

function timestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}
