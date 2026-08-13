import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  OmpRpcClient,
  type OmpRpcClientCallbacks,
  type OmpRpcClientOptions,
  type OmpUiResponse,
} from "./rpc-client.js";

export type OmpRpcRecoveryState =
  "running" | "restarting" | "resumed" | "recovery_failed";

export interface OmpRpcSupervisorOptions extends OmpRpcClientOptions {
  stateDirectory: string;
  maxRestarts?: number;
  restartBackoffMs?: number[];
  clientFactory?: (
    options: OmpRpcClientOptions,
    callbacks: OmpRpcClientCallbacks,
  ) => OmpRpcClient;
}

interface PersistedPrompt {
  message: string;
  streamingBehavior?: "steer" | "followUp";
  acknowledged: boolean;
}

export interface OmpRpcSupervisorState {
  sessionPath?: string;
  lastTerminalTurn?: string;
  pendingPrompt?: PersistedPrompt;
  pendingHostToolIds: string[];
  subagents: Record<string, Record<string, unknown>>;
}

const stateFileName = "rpc-supervisor.json";

/**
 * Owns the omp process and its crash recovery boundary. A prompt is replayed
 * only when no RPC acknowledgement or agent-start frame was observed. Host
 * tool updates/results are deliberately never journaled for replay.
 */
export class OmpRpcSupervisor {
  private client: OmpRpcClient | undefined;
  private state: OmpRpcSupervisorState = emptyState();
  private loaded = false;
  private stopped = true;
  private generation = 0;
  private recoveryPromise: Promise<void> | undefined;
  private replayedPromptResult: Record<string, unknown> | undefined;
  private persistence = Promise.resolve();
  private hostTools: Array<Record<string, unknown>> | undefined;
  private subagentSubscription: "off" | "progress" | "events" | undefined;

  public constructor(
    private readonly options: OmpRpcSupervisorOptions,
    private readonly callbacks: OmpRpcClientCallbacks,
  ) {}

  public async start(): Promise<void> {
    if (this.client) throw new Error("omp RPC supervisor is already running.");
    if (!this.loaded) {
      await this.loadState();
      this.loaded = true;
    }
    this.stopped = false;
    const client = this.createClient();
    this.client = client;
    try {
      await client.start();
      this.emitRecovery("running");
    } catch (error) {
      if (this.client === client) this.client = undefined;
      this.stopped = true;
      throw error;
    }
  }

  public async close(): Promise<void> {
    this.stopped = true;
    delete this.state.pendingPrompt;
    await this.persistState();
    const client = this.client;
    this.client = undefined;
    await client?.close();
  }

  public async restartWithExtensionRoots(
    extensionRoots: string[],
  ): Promise<void> {
    if (this.state.pendingPrompt || this.state.pendingHostToolIds.length > 0) {
      throw new Error(
        "Cannot change the omp extension pool while a turn or host action is active.",
      );
    }
    this.stopped = true;
    const previous = this.client;
    this.client = undefined;
    await previous?.close();
    this.options.extensionRoots = [...extensionRoots];
    this.stopped = false;
    const client = this.createClient();
    this.client = client;
    try {
      await client.start();
      if (this.hostTools) await client.setHostTools(this.hostTools);
      if (this.subagentSubscription) {
        await client.setSubagentSubscription(this.subagentSubscription);
      }
      if (this.state.sessionPath) {
        await client.switchSession(this.state.sessionPath);
      }
      await client.getState();
      this.emitRecovery("resumed");
    } catch (error) {
      if (this.client === client) this.client = undefined;
      this.stopped = true;
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  public async prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<Record<string, unknown>> {
    this.state.pendingPrompt = {
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
      acknowledged: false,
    };
    await this.persistState();
    const generation = this.generation;
    try {
      const result = await this.requireClient().prompt(
        message,
        streamingBehavior,
      );
      if (generation === this.generation && this.state.pendingPrompt) {
        this.state.pendingPrompt.acknowledged = true;
        await this.persistState();
      }
      return result;
    } catch (error) {
      const recovery = this.recoveryPromise;
      if (recovery) {
        await recovery;
        if (this.replayedPromptResult) {
          const result = this.replayedPromptResult;
          this.replayedPromptResult = undefined;
          return result;
        }
      }
      throw error;
    }
  }

  public steer(message: string): Promise<Record<string, unknown>> {
    return this.requireClient().steer(message);
  }

  public followUp(message: string): Promise<Record<string, unknown>> {
    return this.requireClient().followUp(message);
  }

  public abortAndPrompt(message: string): Promise<Record<string, unknown>> {
    delete this.state.pendingPrompt;
    void this.persistState();
    return this.requireClient().abortAndPrompt(message);
  }

  public async abort(): Promise<Record<string, unknown>> {
    delete this.state.pendingPrompt;
    await this.persistState();
    return this.requireClient().abort();
  }

  public setThinkingLevel(level: string): Promise<Record<string, unknown>> {
    return this.requireClient().setThinkingLevel(level);
  }

  public setFastMode(enabled: boolean): Promise<Record<string, unknown>> {
    return this.requireClient().setFastMode(enabled);
  }

  public setInterruptMode(
    mode: "immediate" | "wait",
  ): Promise<Record<string, unknown>> {
    return this.requireClient().setInterruptMode(mode);
  }

  public getAvailableCommands(): Promise<Record<string, unknown>> {
    return this.requireClient().getAvailableCommands();
  }

  public setSteeringMode(
    mode: "all" | "one-at-a-time",
  ): Promise<Record<string, unknown>> {
    return this.requireClient().setSteeringMode(mode);
  }

  public setFollowUpMode(
    mode: "all" | "one-at-a-time",
  ): Promise<Record<string, unknown>> {
    return this.requireClient().setFollowUpMode(mode);
  }

  public compact(instructions?: string): Promise<Record<string, unknown>> {
    return this.requireClient().compact(instructions);
  }

  public setAutoCompaction(enabled: boolean): Promise<Record<string, unknown>> {
    return this.requireClient().setAutoCompaction(enabled);
  }

  public setAutoRetry(enabled: boolean): Promise<Record<string, unknown>> {
    return this.requireClient().setAutoRetry(enabled);
  }

  public abortRetry(): Promise<Record<string, unknown>> {
    return this.requireClient().abortRetry();
  }

  public bash(command: string): Promise<Record<string, unknown>> {
    return this.requireClient().bash(command);
  }

  public abortBash(): Promise<Record<string, unknown>> {
    return this.requireClient().abortBash();
  }

  public async newSession(
    parentSession?: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.requireClient().newSession(parentSession);
    await this.captureSessionPath(result);
    return result;
  }

  public async getState(): Promise<Record<string, unknown>> {
    const result = await this.requireClient().getState();
    await this.captureSessionPath(result);
    return result;
  }

  public getMessagesPage(cursor?: string): Promise<Record<string, unknown>> {
    return this.requireClient().getMessagesPage(cursor);
  }

  public getAvailableModels(): Promise<Record<string, unknown>> {
    return this.requireClient().getAvailableModels();
  }

  public cycleModel(): Promise<Record<string, unknown>> {
    return this.requireClient().cycleModel();
  }

  public cycleThinkingLevel(): Promise<Record<string, unknown>> {
    return this.requireClient().cycleThinkingLevel();
  }

  public setModel(
    provider: string,
    modelId: string,
  ): Promise<Record<string, unknown>> {
    return this.requireClient().setModel(provider, modelId);
  }

  public getLoginProviders(): Promise<Record<string, unknown>> {
    return this.requireClient().getLoginProviders();
  }

  public login(providerId: string): Promise<Record<string, unknown>> {
    return this.requireClient().login(providerId);
  }

  public async setHostTools(
    definitions: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.hostTools = definitions.map((definition) => ({ ...definition }));
    return this.requireClient().setHostTools(definitions);
  }

  public setTodos(
    phases: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.requireClient().setTodos(phases);
  }

  public setSessionName(name: string): Promise<Record<string, unknown>> {
    return this.requireClient().setSessionName(name);
  }

  public async switchSession(
    sessionPath: string,
  ): Promise<Record<string, unknown>> {
    const result = await this.requireClient().switchSession(sessionPath);
    this.state.sessionPath = sessionPath;
    await this.persistState();
    return result;
  }

  public exportHtml(outputPath?: string): Promise<Record<string, unknown>> {
    return this.requireClient().exportHtml(outputPath);
  }

  public getSessionStats(): Promise<Record<string, unknown>> {
    return this.requireClient().getSessionStats();
  }

  public branch(entryId: string): Promise<Record<string, unknown>> {
    return this.requireClient().branch(entryId);
  }

  public getBranchMessages(): Promise<Record<string, unknown>> {
    return this.requireClient().getBranchMessages();
  }

  public getLastAssistantText(): Promise<Record<string, unknown>> {
    return this.requireClient().getLastAssistantText();
  }

  public handoff(instructions?: string): Promise<Record<string, unknown>> {
    return this.requireClient().handoff(instructions);
  }

  public async setSubagentSubscription(
    level: "off" | "progress" | "events",
  ): Promise<Record<string, unknown>> {
    this.subagentSubscription = level;
    return this.requireClient().setSubagentSubscription(level);
  }

  public getSubagents(): Promise<Record<string, unknown>> {
    return this.requireClient().getSubagents();
  }

  public getSubagentMessages(options: {
    subagentId?: string;
    sessionFile?: string;
    fromByte?: number;
  }): Promise<Record<string, unknown>> {
    return this.requireClient().getSubagentMessages(options);
  }

  public uiResponse(id: string, response: OmpUiResponse): Promise<void> {
    return this.requireClient().uiResponse(id, response);
  }

  public hostToolUpdate(
    id: string,
    partialResult: Record<string, unknown>,
  ): void {
    this.requireClient().hostToolUpdate(id, partialResult);
  }

  public hostToolResult(
    id: string,
    result: Record<string, unknown>,
    isError = false,
  ): void {
    this.state.pendingHostToolIds = this.state.pendingHostToolIds.filter(
      (candidate) => candidate !== id,
    );
    void this.persistState();
    this.requireClient().hostToolResult(id, result, isError);
  }

  public snapshot(): OmpRpcSupervisorState {
    return structuredClone(this.state);
  }

  private createClient(): OmpRpcClient {
    const generation = ++this.generation;
    let closeHandled = false;
    const factory =
      this.options.clientFactory ??
      ((options: OmpRpcClientOptions, callbacks: OmpRpcClientCallbacks) =>
        new OmpRpcClient(options, callbacks));
    return factory(this.clientOptions(), {
      onEvent: (frame) => this.handleEvent(frame),
      ...(this.callbacks.onSubagent
        ? { onSubagent: this.callbacks.onSubagent }
        : {}),
      onUiRequest: this.callbacks.onUiRequest,
      onHostToolCall: (frame) => this.handleHostToolCall(frame),
      onLog: this.callbacks.onLog,
      onClosed: (error) => {
        if (closeHandled || generation !== this.generation) return;
        closeHandled = true;
        this.handleClosed(error);
      },
    });
  }

  private clientOptions(): OmpRpcClientOptions {
    return {
      binary: this.options.binary,
      workspaceRoot: this.options.workspaceRoot,
      sessionDir: this.options.sessionDir,
      ...(this.options.args ? { args: [...this.options.args] } : {}),
      ...(this.options.extensionRoots
        ? { extensionRoots: [...this.options.extensionRoots] }
        : {}),
      ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
    };
  }

  private handleEvent(frame: Record<string, unknown>): void {
    if (frame.type === "agent_start" && this.state.pendingPrompt) {
      this.state.pendingPrompt.acknowledged = true;
      void this.persistState();
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) {
      delete this.state.pendingPrompt;
      const terminalTurn = firstString(
        frame.turnId,
        frame.entryId,
        frame.messageId,
        frame.turn,
      );
      if (terminalTurn) this.state.lastTerminalTurn = terminalTurn;
      void this.persistState();
    }
    const sessionPath = sessionPathFrom(frame);
    if (sessionPath && sessionPath !== this.state.sessionPath) {
      this.state.sessionPath = sessionPath;
      void this.persistState();
    }
    if (
      frame.type === "subagent_lifecycle" ||
      frame.type === "subagent_progress" ||
      frame.type === "subagent_event"
    ) {
      const payload =
        frame.payload &&
        typeof frame.payload === "object" &&
        !Array.isArray(frame.payload)
          ? (frame.payload as Record<string, unknown>)
          : frame;
      const progress =
        payload.progress &&
        typeof payload.progress === "object" &&
        !Array.isArray(payload.progress)
          ? (payload.progress as Record<string, unknown>)
          : {};
      const id = firstString(
        payload.subagentId,
        payload.id,
        payload.agentId,
        progress.id,
      );
      if (id) {
        const previous = this.state.subagents[id];
        const status = firstString(
          progress.status,
          payload.status === "started" ? "running" : payload.status,
        );
        const next: Record<string, unknown> = {
          ...previous,
          ...payload,
          ...progress,
          ...(status ? { status } : {}),
        };
        if (
          frame.type === "subagent_lifecycle" &&
          payload.status !== "started"
        ) {
          next.completedAt = new Date().toISOString();
        }
        this.state.subagents[id] = next;
        void this.persistState();
      }
    }
    this.callbacks.onEvent(frame);
  }

  private handleHostToolCall(frame: Record<string, unknown>): void {
    if (frame.type === "host_tool_call") {
      const id = firstString(frame.id, frame.callId);
      if (id && !this.state.pendingHostToolIds.includes(id)) {
        this.state.pendingHostToolIds.push(id);
        void this.persistState();
      }
    } else if (frame.type === "host_tool_cancel") {
      const id = firstString(frame.targetId, frame.id, frame.callId);
      if (id) {
        this.state.pendingHostToolIds = this.state.pendingHostToolIds.filter(
          (candidate) => candidate !== id,
        );
        void this.persistState();
      }
    }
    this.callbacks.onHostToolCall(frame);
  }

  private handleClosed(error: Error | undefined): void {
    this.client = undefined;
    if (this.stopped || this.recoveryPromise) return;
    this.recoveryPromise = this.recover(error).finally(() => {
      this.recoveryPromise = undefined;
    });
  }

  private async recover(initialError: Error | undefined): Promise<void> {
    this.emitRecovery("restarting", initialError);
    let lastError = initialError ?? new Error("omp RPC process closed.");
    const maxRestarts = this.options.maxRestarts ?? 2;
    for (let attempt = 0; attempt < maxRestarts; attempt += 1) {
      await delay(
        this.options.restartBackoffMs?.[attempt] ??
          Math.min(1_000, 100 * 2 ** attempt),
      );
      if (this.stopped) return;
      const client = this.createClient();
      this.client = client;
      try {
        await client.start();
        if (this.hostTools) await client.setHostTools(this.hostTools);
        if (this.subagentSubscription) {
          await client.setSubagentSubscription(this.subagentSubscription);
        }
        if (this.state.sessionPath) {
          await client.switchSession(this.state.sessionPath);
        }
        const liveState = await client.getState();
        await this.captureSessionPath(liveState);
        if (
          this.state.pendingPrompt &&
          !this.state.pendingPrompt.acknowledged &&
          this.state.pendingHostToolIds.length === 0
        ) {
          const prompt = this.state.pendingPrompt;
          this.replayedPromptResult = await client.prompt(
            prompt.message,
            prompt.streamingBehavior,
          );
          prompt.acknowledged = true;
          await this.persistState();
        }
        this.emitRecovery("resumed");
        return;
      } catch (error) {
        lastError = asError(error);
        if (this.client === client) this.client = undefined;
        await client.close().catch(() => undefined);
      }
    }
    this.stopped = true;
    this.emitRecovery("recovery_failed", lastError);
    this.callbacks.onClosed(lastError);
    throw lastError;
  }

  private emitRecovery(state: OmpRpcRecoveryState, error?: Error): void {
    this.callbacks.onEvent({
      type: "rpc_recovery",
      state,
      ...(error ? { error: error.message } : {}),
    });
  }

  private async captureSessionPath(
    data: Record<string, unknown>,
  ): Promise<void> {
    const sessionPath = sessionPathFrom(data);
    if (!sessionPath || sessionPath === this.state.sessionPath) return;
    this.state.sessionPath = sessionPath;
    await this.persistState();
  }

  private requireClient(): OmpRpcClient {
    if (!this.client) throw new Error("omp RPC process is not running.");
    return this.client;
  }

  private async loadState(): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(
        await readFile(
          join(this.options.stateDirectory, stateFileName),
          "utf8",
        ),
      ) as unknown;
      this.state = parseState(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.callbacks.onLog(
          `Ignoring invalid omp RPC recovery state: ${asError(error).message}\n`,
        );
      }
      this.state = emptyState();
    }
  }

  private persistState(): Promise<void> {
    const serialized = `${JSON.stringify(this.state, null, 2)}\n`;
    const path = join(this.options.stateDirectory, stateFileName);
    const temporary = `${path}.${process.pid}.tmp`;
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.options.stateDirectory, {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(temporary, serialized, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, path);
      });
    return this.persistence;
  }
}

function emptyState(): OmpRpcSupervisorState {
  return { pendingHostToolIds: [], subagents: {} };
}

function parseState(value: unknown): OmpRpcSupervisorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recovery state must be an object.");
  }
  const input = value as Record<string, unknown>;
  const result = emptyState();
  if (typeof input.sessionPath === "string")
    result.sessionPath = input.sessionPath;
  if (typeof input.lastTerminalTurn === "string") {
    result.lastTerminalTurn = input.lastTerminalTurn;
  }
  if (Array.isArray(input.pendingHostToolIds)) {
    result.pendingHostToolIds = input.pendingHostToolIds.filter(
      (id): id is string => typeof id === "string",
    );
  }
  if (input.pendingPrompt && typeof input.pendingPrompt === "object") {
    const prompt = input.pendingPrompt as Record<string, unknown>;
    if (typeof prompt.message === "string") {
      result.pendingPrompt = {
        message: prompt.message,
        acknowledged: prompt.acknowledged === true,
        ...(prompt.streamingBehavior === "steer" ||
        prompt.streamingBehavior === "followUp"
          ? { streamingBehavior: prompt.streamingBehavior }
          : {}),
      };
    }
  }
  if (
    input.subagents &&
    typeof input.subagents === "object" &&
    !Array.isArray(input.subagents)
  ) {
    for (const [id, state] of Object.entries(input.subagents)) {
      if (state && typeof state === "object" && !Array.isArray(state)) {
        result.subagents[id] = state as Record<string, unknown>;
      }
    }
  }
  return result;
}

function sessionPathFrom(data: Record<string, unknown>): string | undefined {
  return firstString(data.sessionPath, data.sessionFile, data.path);
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
