import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

export interface OmpRpcClientOptions {
  binary: string;
  workspaceRoot: string;
  sessionDir: string;
  args?: string[];
  extensionRoots?: string[];
  /** Extra environment variables for the omp child process. */
  env?: Record<string, string>;
  spawn?: typeof nodeSpawn;
  /**
   * Upper bound on the RPC protocol version this client will negotiate
   * (default 2). A server that advertises only higher versions is rejected at
   * startup instead of being guessed at.
   */
  maxRpcProtocolVersion?: number;
  /** How long to wait for the v2 negotiation acknowledgement (ms). */
  negotiationTimeoutMs?: number;
}

/**
 * Feature support is never invented: a server either advertises the feature,
 * proves it (probe), or reports it as unknown.
 */
export type CapabilityState = "supported" | "unsupported" | "unknown";

/**
 * Capability surface negotiated from the omp `ready` frame at startup.
 * Absent advertisements are `"unknown"`, never silently treated as
 * supported.
 */
export interface OmpCapabilities {
  /** Negotiated RPC protocol version (1 when the server pre-dates negotiation). */
  rpcProtocolVersion: number;
  /** Host-tool support; an explicit `unsupported` is fatal to startup. */
  hostTools: CapabilityState;
  hostToolCancellation: CapabilityState;
  subagentEvents: CapabilityState;
  sessionSwitch: CapabilityState;
  interruptModes: CapabilityState;
  /** Advertised interrupt modes; empty when not advertised. */
  interruptModeValues: string[];
}

interface Negotiation {
  requested: number;
  resolve(version: number): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
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

function formatProtocolVersions(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0)
    return "no protocol versions";
  return value.map(String).join(", ");
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
  private negotiatedCapabilities: OmpCapabilities | undefined;
  private readonly maxProtocolVersion: number;
  private readonly negotiationTimeoutMs: number;
  private negotiation: Negotiation | undefined;
  private startFailure: Error | undefined;
  private exited = false;
  private stderrTail = "";
  private startResolve: (() => void) | undefined;
  private startReject: ((error: Error) => void) | undefined;

  public constructor(
    private readonly options: OmpRpcClientOptions,
    private readonly callbacks: OmpRpcClientCallbacks,
  ) {
    const configured = options.maxRpcProtocolVersion ?? 2;
    this.maxProtocolVersion = Math.min(2, Math.max(1, configured));
    this.negotiationTimeoutMs = Math.max(
      1,
      options.negotiationTimeoutMs ?? 10_000,
    );
  }

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
      {
        stdio: ["pipe", "pipe", "pipe"],
        ...(this.options.env
          ? { env: { ...process.env, ...this.options.env } }
          : {}),
      },
    );
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      this.callbacks.onLog(text);
    });
    child.once("error", (error) => {
      this.exited = true;
      this.negotiation?.reject(
        error ??
          new Error("omp RPC process failed during protocol negotiation."),
      );
      this.negotiation = undefined;
      this.rejectAll(error);
      this.startReject?.(error);
      this.startResolve = undefined;
      this.startReject = undefined;
      if (!this.startFailure) this.callbacks.onClosed(error);
    });
    child.once("exit", (code, signal) => {
      this.exited = true;
      const diagnostic = this.stderrTail.trim();
      const error =
        code === 0 && !signal
          ? undefined
          : new Error(
              `omp RPC process exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.${diagnostic ? `\n${diagnostic}` : ""}`,
            );
      this.negotiation?.reject(
        error ??
          new Error("omp RPC process exited during protocol negotiation."),
      );
      this.negotiation = undefined;
      this.rejectAll(error);
      this.startReject?.(error ?? new Error("omp RPC process exited early."));
      this.startResolve = undefined;
      this.startReject = undefined;
      if (!this.startFailure) this.callbacks.onClosed(error);
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

  /**
   * Negotiated capabilities, populated once the omp `ready` frame arrives.
   * Returns `undefined` before startup completes or after the process closed.
   */
  public capabilities(): OmpCapabilities | undefined {
    return this.negotiatedCapabilities;
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
      if (frame.hostTools === false) {
        // LHIC's integration is built on host tools; an explicit refusal is
        // an incompatible server, not a feature to silently disable.
        this.failStart(
          new Error(
            "omp RPC capability check failed: the omp binary reports host tools are disabled, but LHIC requires them.",
          ),
        );
        return;
      }
      const negotiated = this.negotiateProtocol(frame);
      if (negotiated === undefined) {
        this.failStart(
          new Error(
            `omp RPC protocol incompatibility: the omp binary advertises ${formatProtocolVersions(frame.supportedProtocolVersions)}, but LHIC supports protocol 1..${this.maxProtocolVersion}. Refusing to run an incompatible omp binary.`,
          ),
        );
        return;
      }
      if (negotiated >= 2) {
        // Protocol v2 is a real request/response: startup completes only
        // after the server acknowledges the negotiated version.
        this.writeLine(
          JSON.stringify({
            id: "protocol-1",
            type: "negotiate_protocol",
            protocolVersion: negotiated,
          }),
        );
        const timer = setTimeout(() => {
          this.negotiation?.reject(
            new Error(
              "omp RPC protocol negotiation timed out; the omp binary did not acknowledge the negotiated protocol.",
            ),
          );
        }, this.negotiationTimeoutMs);
        const negotiation = new Promise<number>((resolve, reject) => {
          this.negotiation = {
            requested: negotiated,
            resolve: (version) => {
              clearTimeout(timer);
              resolve(version);
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
            timer,
          };
        });
        void negotiation.then(
          (confirmed) => {
            this.negotiation = undefined;
            this.negotiatedCapabilities = this.capabilitiesFromFrame(
              frame,
              confirmed,
            );
            this.startResolve?.();
            this.startResolve = undefined;
            this.startReject = undefined;
          },
          (error: Error) => {
            this.negotiation = undefined;
            this.failStart(error);
          },
        );
        return;
      }
      // Protocol v1: no negotiation round-trip.
      this.negotiatedCapabilities = this.capabilitiesFromFrame(frame, 1);
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
    let decoded: string;
    try {
      // Fatal decoding: malformed UTF-8 must be rejected, never silently
      // replaced with U+FFFD and then executed as a frame.
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(reassembled);
    } catch {
      this.callbacks.onLog(
        "Rejecting omp RPC chunk frame with malformed UTF-8.",
      );
      return;
    }
    this.handleLine(decoded);
  }

  private handleResponse(frame: Record<string, unknown>): void {
    const id = String(frame.id ?? "");
    if (id === "protocol-1" && this.negotiation) {
      const negotiation = this.negotiation;
      if (frame.success === false) {
        negotiation.reject(
          new Error(
            `omp RPC protocol negotiation failed: ${String(frame.error ?? "the omp binary rejected the negotiated protocol")}.`,
          ),
        );
        return;
      }
      const confirmedData =
        frame.data &&
        typeof frame.data === "object" &&
        !Array.isArray(frame.data)
          ? (frame.data as Record<string, unknown>)
          : undefined;
      const confirmed =
        confirmedData && typeof confirmedData.protocolVersion === "number"
          ? confirmedData.protocolVersion
          : undefined;
      if (confirmed !== undefined && confirmed !== negotiation.requested) {
        negotiation.reject(
          new Error(
            `omp RPC protocol negotiation mismatch: requested v${negotiation.requested}, the omp binary acknowledged v${confirmed}.`,
          ),
        );
        return;
      }
      negotiation.resolve(negotiation.requested);
      return;
    }
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

  /**
   * Picks the highest protocol version the server supports within
   * `1..maxProtocolVersion`. Servers that pre-date capability advertisement
   * default to v1. Returns `undefined` when no overlap exists — the server
   * must be rejected, never guessed at.
   */
  private negotiateProtocol(
    frame: Record<string, unknown>,
  ): number | undefined {
    const raw = frame.supportedProtocolVersions;
    if (!Array.isArray(raw)) return 1;
    const supported = raw.filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= this.maxProtocolVersion,
    );
    if (supported.length === 0) return undefined;
    return Math.max(...supported);
  }

  private capabilitiesFromFrame(
    frame: Record<string, unknown>,
    rpcProtocolVersion: number,
  ): OmpCapabilities {
    const stateOf = (key: string): CapabilityState =>
      frame[key] === true
        ? "supported"
        : frame[key] === false
          ? "unsupported"
          : "unknown";
    const interruptModeValues = Array.isArray(frame.interruptModes)
      ? frame.interruptModes.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      rpcProtocolVersion,
      hostTools: stateOf("hostTools"),
      hostToolCancellation: stateOf("hostToolCancellation"),
      subagentEvents: stateOf("subagentEvents"),
      sessionSwitch: stateOf("sessionSwitch"),
      interruptModes: Array.isArray(frame.interruptModes)
        ? interruptModeValues.length > 0
          ? "supported"
          : "unsupported"
        : "unknown",
      interruptModeValues,
    };
  }

  /**
   * Terminates a start that failed a capability check. The failure is fatal:
   * the supervisor must not retry an incompatible binary, so no `onClosed`
   * recovery signal is emitted.
   */
  private failStart(error: Error): void {
    this.startFailure = error;
    this.startReject?.(error);
    this.startResolve = undefined;
    this.startReject = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || this.exited) return;
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => clearTimeout(timer));
    try {
      child.stdin?.end();
    } catch {
      child.kill("SIGTERM");
    }
  }

  private writeLine(line: string): void {
    const child = this.child;
    if (!child || !child.stdin?.writable || this.exited) {
      throw new Error("omp RPC process is not running.");
    }
    child.stdin.write(`${line}\n`);
  }
}
