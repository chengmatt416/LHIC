import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export interface OmpRpcClientOptions {
  binary: string;
  workspaceRoot: string;
  sessionDir: string;
  args?: string[];
  extensionRoots?: string[];
  spawn?: typeof nodeSpawn;
}

export type OmpSubagentFrame = Record<string, unknown> & {
  type: "subagent_lifecycle" | "subagent_progress" | "subagent_event";
};

export interface OmpRpcClientCallbacks {
  onEvent(frame: Record<string, unknown>): void;
  onSubagent?(frame: OmpSubagentFrame): void;
  onUiRequest(frame: Record<string, unknown>): void;
  onHostToolCall(frame: Record<string, unknown>): void;
  onClosed(error?: Error): void;
  onLog(line: string): void;
}

export interface OmpUiResponse {
  value?: string;
  confirmed?: boolean;
  cancelled?: boolean;
}

/**
 * Host tools exposed to the omp agent. Execution is approval-gated by the
 * local DesktopBrowserRunner / DesktopGlobalRunner regardless of omp's mode.
 */
export function lhicHostToolDefinitions(): Array<{
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
}> {
  return [
    {
      name: "lhic_browser_execute",
      label: "LHIC Browser",
      description:
        "Execute a browser-plan-v1 plan with the local LHIC browser runner (visible Chromium, per-step approval, verifier evidence).",
      parameters: {
        type: "object",
        properties: {
          plan: { type: "object" },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
    {
      name: "lhic_desktop_observe",
      label: "LHIC Desktop Observe",
      description:
        "Observe a bounded desktop scope after exact-action approval. Returns normalized ephemeral elements and backend evidence; never returns a screenshot path.",
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
      name: "lhic_desktop_execute",
      label: "LHIC Desktop",
      description:
        "Execute a desktop-plan-v1 plan with the local LHIC global desktop executor (every OS action requires approval and a post-action verifier).",
      parameters: {
        type: "object",
        properties: {
          plan: { type: "object" },
        },
        required: ["plan"],
        additionalProperties: false,
      },
    },
  ];
}

interface PendingRequest {
  resolve(data: Record<string, unknown>): void;
  reject(error: Error): void;
}

interface ChunkAssembly {
  chunkId: string;
  count: number;
  byteLength: number;
  segments: Buffer[];
}

const defaultReassemblyLimit = 64 * 1024 * 1024;

/**
 * Newline-delimited JSON RPC client for `omp --mode rpc` (protocol v1/v2,
 * lossless chunked framing). One child process per client; stdout lines are
 * parsed as frames, `rpc_chunk` sequences are reassembled with the advertised
 * size caps, and responses correlate with requests by generated `req_<n>` ids.
 */
export class OmpRpcClient {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = "";
  private requestCounter = 0;
  private assembly: ChunkAssembly | undefined;
  private ready: { maxReassembledFrameBytes: number } | undefined;
  private exited = false;
  private startResolve: (() => void) | undefined;
  private startReject: ((error: Error) => void) | undefined;

  public constructor(
    private readonly options: OmpRpcClientOptions,
    private readonly callbacks: OmpRpcClientCallbacks,
  ) {}

  public start(): Promise<void> {
    if (this.child) {
      return Promise.reject(new Error("omp RPC client is already running."));
    }
    const spawn = this.options.spawn ?? nodeSpawn;
    const child = spawn(
      this.options.binary,
      [
        "--mode",
        "rpc",
        "--cwd",
        this.options.workspaceRoot,
        "--session-dir",
        this.options.sessionDir,
        "--no-pty",
        "--hide-thinking",
        "--approval-mode",
        "write",
        ...(this.options.extensionRoots ?? []).flatMap((root) => [
          "--extension",
          root,
        ]),
        ...(this.options.args ?? []),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      this.callbacks.onLog(String(chunk));
    });
    child.once("error", (error) => {
      this.exited = true;
      this.rejectAll(error);
      this.startReject?.(error);
      this.startResolve = undefined;
      this.startReject = undefined;
      this.callbacks.onClosed(error);
    });
    child.once("exit", (code, signal) => {
      this.exited = true;
      const error =
        code === 0 && !signal
          ? undefined
          : new Error(
              `omp RPC process exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`,
            );
      this.rejectAll(error);
      this.startReject?.(error ?? new Error("omp RPC process exited early."));
      this.startResolve = undefined;
      this.startReject = undefined;
      this.callbacks.onClosed(error);
    });
    return new Promise<void>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
  }

  public send(
    command: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<Record<string, unknown>> {
    if (this.exited) {
      return Promise.reject(new Error("omp RPC process is not running."));
    }
    const id = `req_${this.requestCounter++}`;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp RPC command ${String(command.type)} timed out.`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.writeLine(JSON.stringify({ ...command, id }));
    });
  }

  public prompt(
    message: string,
    streamingBehavior?: "steer" | "followUp",
  ): Promise<Record<string, unknown>> {
    return this.send({
      type: "prompt",
      message,
      ...(streamingBehavior ? { streamingBehavior } : {}),
    });
  }

  public steer(message: string): Promise<Record<string, unknown>> {
    return this.send({ type: "steer", message });
  }

  public followUp(message: string): Promise<Record<string, unknown>> {
    return this.send({ type: "follow_up", message });
  }

  public abortAndPrompt(message: string): Promise<Record<string, unknown>> {
    return this.send({ type: "abort_and_prompt", message });
  }
  public setThinkingLevel(level: string): Promise<Record<string, unknown>> {
    return this.send({ type: "set_thinking_level", level });
  }

  public setFastMode(enabled: boolean): Promise<Record<string, unknown>> {
    return this.send({ type: "set_fast_mode", enabled });
  }

  public setInterruptMode(
    mode: "immediate" | "wait",
  ): Promise<Record<string, unknown>> {
    return this.send({ type: "set_interrupt_mode", mode });
  }

  public getAvailableCommands(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_available_commands" });
  }
  public setSteeringMode(
    mode: "all" | "one-at-a-time",
  ): Promise<Record<string, unknown>> {
    return this.send({ type: "set_steering_mode", mode });
  }

  public setFollowUpMode(
    mode: "all" | "one-at-a-time",
  ): Promise<Record<string, unknown>> {
    return this.send({ type: "set_follow_up_mode", mode });
  }

  public compact(
    customInstructions?: string,
  ): Promise<Record<string, unknown>> {
    return this.send({
      type: "compact",
      ...(customInstructions ? { customInstructions } : {}),
    });
  }

  public setAutoCompaction(enabled: boolean): Promise<Record<string, unknown>> {
    return this.send({ type: "set_auto_compaction", enabled });
  }

  public setAutoRetry(enabled: boolean): Promise<Record<string, unknown>> {
    return this.send({ type: "set_auto_retry", enabled });
  }

  public abortRetry(): Promise<Record<string, unknown>> {
    return this.send({ type: "abort_retry" });
  }

  public bash(command: string): Promise<Record<string, unknown>> {
    return this.send({ type: "bash", command });
  }

  public abortBash(): Promise<Record<string, unknown>> {
    return this.send({ type: "abort_bash" });
  }

  public abort(): Promise<Record<string, unknown>> {
    return this.send({ type: "abort" });
  }

  public newSession(parentSession?: string): Promise<Record<string, unknown>> {
    return this.send({
      type: "new_session",
      ...(parentSession ? { parentSession } : {}),
    });
  }

  public getState(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_state" });
  }

  public getMessagesPage(cursor?: string): Promise<Record<string, unknown>> {
    return this.send({
      type: "get_messages_page",
      ...(cursor ? { cursor } : {}),
    });
  }

  public getAvailableModels(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_available_models" });
  }
  public cycleModel(): Promise<Record<string, unknown>> {
    return this.send({ type: "cycle_model" });
  }

  public cycleThinkingLevel(): Promise<Record<string, unknown>> {
    return this.send({ type: "cycle_thinking_level" });
  }

  public setModel(
    provider: string,
    modelId: string,
  ): Promise<Record<string, unknown>> {
    return this.send({ type: "set_model", provider, modelId });
  }

  public getLoginProviders(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_login_providers" });
  }

  public login(providerId: string): Promise<Record<string, unknown>> {
    return this.send({ type: "login", providerId });
  }

  public setHostTools(
    definitions: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.send({ type: "set_host_tools", tools: definitions });
  }

  public setTodos(
    phases: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    return this.send({ type: "set_todos", phases });
  }

  public setSessionName(name: string): Promise<Record<string, unknown>> {
    return this.send({ type: "set_session_name", name });
  }

  public switchSession(sessionPath: string): Promise<Record<string, unknown>> {
    return this.send({ type: "switch_session", sessionPath });
  }

  public exportHtml(outputPath?: string): Promise<Record<string, unknown>> {
    return this.send({
      type: "export_html",
      ...(outputPath ? { outputPath } : {}),
    });
  }
  public getSessionStats(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_session_stats" });
  }

  public branch(entryId: string): Promise<Record<string, unknown>> {
    return this.send({ type: "branch", entryId });
  }

  public getBranchMessages(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_branch_messages" });
  }

  public getLastAssistantText(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_last_assistant_text" });
  }

  public handoff(
    customInstructions?: string,
  ): Promise<Record<string, unknown>> {
    return this.send({
      type: "handoff",
      ...(customInstructions ? { customInstructions } : {}),
    });
  }

  public setSubagentSubscription(
    level: "off" | "progress" | "events",
  ): Promise<Record<string, unknown>> {
    return this.send({ type: "set_subagent_subscription", level });
  }

  public getSubagents(): Promise<Record<string, unknown>> {
    return this.send({ type: "get_subagents" });
  }

  public getSubagentMessages(options: {
    subagentId?: string;
    sessionFile?: string;
    fromByte?: number;
  }): Promise<Record<string, unknown>> {
    return this.send({ type: "get_subagent_messages", ...options });
  }

  public uiResponse(id: string, response: OmpUiResponse): Promise<void> {
    const frame: Record<string, unknown> = {
      type: "extension_ui_response",
      id,
    };
    if (response.cancelled) {
      frame.cancelled = true;
    } else if (response.confirmed !== undefined) {
      frame.confirmed = response.confirmed;
    } else {
      frame.value = response.value ?? "";
    }
    this.writeLine(JSON.stringify(frame));
    return Promise.resolve();
  }

  public hostToolUpdate(
    id: string,
    partialResult: Record<string, unknown>,
  ): void {
    this.writeLine(
      JSON.stringify({ type: "host_tool_update", id, partialResult }),
    );
  }

  public hostToolResult(
    id: string,
    result: Record<string, unknown>,
    isError = false,
  ): void {
    this.writeLine(
      JSON.stringify({
        type: "host_tool_result",
        id,
        ...(isError ? { isError: true } : {}),
        result,
      }),
    );
  }

  public close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || this.exited) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGTERM"), 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin?.end();
      } catch {
        child.kill("SIGTERM");
      }
    });
  }

  private onStdout(chunk: Buffer): void {
    this.buffer += String(chunk);
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trimEnd();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.callbacks.onLog(`Ignoring malformed omp RPC frame: ${line}`);
      return;
    }
    if (frame.type === "ready") {
      this.ready = {
        maxReassembledFrameBytes:
          typeof frame.maxReassembledFrameBytes === "number"
            ? frame.maxReassembledFrameBytes
            : defaultReassemblyLimit,
      };
      const supported = frame.supportedProtocolVersions;
      if (Array.isArray(supported) && supported.includes(2)) {
        this.writeLine(
          JSON.stringify({
            id: "protocol-1",
            type: "negotiate_protocol",
            protocolVersion: 2,
          }),
        );
      }
      this.startResolve?.();
      this.startResolve = undefined;
      this.startReject = undefined;
      return;
    }
    if (frame.type === "rpc_chunk") {
      this.handleChunk(frame);
      return;
    }
    if (this.assembly) {
      // Interleaved frames invalidate an in-flight chunk sequence.
      this.assembly = undefined;
      this.callbacks.onLog("Discarding interrupted omp RPC chunk sequence.");
    }
    if (frame.type === "response") {
      this.handleResponse(frame);
      return;
    }
    if (frame.type === "extension_ui_request") {
      this.callbacks.onUiRequest(frame);
      return;
    }
    if (frame.type === "host_tool_call" || frame.type === "host_tool_cancel") {
      this.callbacks.onHostToolCall(frame);
      return;
    }
    if (
      frame.type === "subagent_lifecycle" ||
      frame.type === "subagent_progress" ||
      frame.type === "subagent_event"
    ) {
      this.callbacks.onSubagent?.(frame as OmpSubagentFrame);
    }
    this.callbacks.onEvent(frame);
  }

  private handleChunk(frame: Record<string, unknown>): void {
    const chunkId = String(frame.chunkId ?? "");
    const index = Number(frame.index);
    const count = Number(frame.count);
    const byteLength = Number(frame.byteLength);
    const data = String(frame.data ?? "");
    const limit = Math.min(
      this.ready?.maxReassembledFrameBytes ?? defaultReassemblyLimit,
      defaultReassemblyLimit,
    );
    if (
      !chunkId ||
      !Number.isInteger(index) ||
      index < 0 ||
      !Number.isInteger(count) ||
      count < 1 ||
      index >= count ||
      !Number.isInteger(byteLength) ||
      byteLength < 0 ||
      byteLength > limit
    ) {
      this.assembly = undefined;
      this.callbacks.onLog("Ignoring invalid omp RPC chunk frame.");
      return;
    }
    if (!this.assembly || this.assembly.chunkId !== chunkId) {
      this.assembly = {
        chunkId,
        count,
        byteLength,
        segments: [],
      };
    }
    const assembly = this.assembly;
    if (
      assembly.count !== count ||
      assembly.byteLength !== byteLength ||
      index !== assembly.segments.length
    ) {
      this.assembly = undefined;
      this.callbacks.onLog("Rejecting out-of-order omp RPC chunk sequence.");
      return;
    }
    const segment = Buffer.from(data, "base64");
    const assembledBytes =
      assembly.segments.reduce((total, value) => total + value.length, 0) +
      segment.length;
    if (assembledBytes > assembly.byteLength || assembledBytes > limit) {
      this.assembly = undefined;
      this.callbacks.onLog("Rejecting oversized omp RPC chunk sequence.");
      return;
    }
    assembly.segments.push(segment);
    if (assembly.segments.length !== count) {
      return;
    }
    const reassembled = Buffer.concat(assembly.segments);
    this.assembly = undefined;
    if (reassembled.length !== byteLength) {
      this.callbacks.onLog(
        `Rejecting omp RPC chunk reassembly: expected ${byteLength} bytes, got ${reassembled.length}.`,
      );
      return;
    }
    if (reassembled.length > limit) {
      this.callbacks.onLog(
        `Rejecting omp RPC frame above the ${limit}-byte reassembly ceiling.`,
      );
      return;
    }
    this.handleLine(reassembled.toString("utf8"));
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = String(frame.id ?? "");
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (frame.success === false) {
      pending.reject(
        new Error(
          String(
            frame.error ?? `omp RPC command ${String(frame.command)} failed.`,
          ),
        ),
      );
      return;
    }
    pending.resolve(
      frame.data && typeof frame.data === "object"
        ? (frame.data as Record<string, unknown>)
        : {},
    );
  }

  private rejectAll(error: Error | undefined): void {
    for (const pending of this.pending.values()) {
      pending.reject(error ?? new Error("omp RPC process closed."));
    }
    this.pending.clear();
  }

  private writeLine(line: string): void {
    const child = this.child;
    if (!child || !child.stdin?.writable || this.exited) {
      throw new Error("omp RPC process is not running.");
    }
    child.stdin.write(`${line}\n`);
  }
}
