import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn as nodeSpawn } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { OmpRpcClient, type OmpRpcClientCallbacks } from "./rpc-client.js";

describe("OmpRpcClient", () => {
  it("starts protocol v2, correlates commands, and routes chunked events", async () => {
    const harness = fakeProcess();
    const callbacks = fakeCallbacks();
    const client = new OmpRpcClient(
      {
        binary: "/opt/omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        extensionRoots: ["/state/model pool", "/state/second;pool"],
        spawn: harness.spawn,
      },
      callbacks,
    );

    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: {},
      })}\n`,
    );
    await started;

    expect(harness.spawn).toHaveBeenCalledWith(
      "/opt/omp",
      [
        "--mode",
        "rpc",
        "--cwd",
        "/workspace",
        "--session-dir",
        "/sessions",
        "--no-pty",
        "--hide-thinking",
        "--approval-mode",
        "write",
        "--extension",
        "/state/model pool",
        "--extension",
        "/state/second;pool",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(harness.writes()).toContainEqual({
      id: "protocol-1",
      type: "negotiate_protocol",
      protocolVersion: 2,
    });

    const prompt = client.prompt("hello");
    expect(harness.writes().at(-1)).toMatchObject({
      id: "req_0",
      type: "prompt",
      message: "hello",
    });
    harness.stdout.write(
      `${JSON.stringify({ type: "response", id: "req_0", success: true, data: { accepted: true } })}\n`,
    );
    await expect(prompt).resolves.toEqual({ accepted: true });

    const logical = Buffer.from(
      JSON.stringify({ type: "message_update", messageId: "m1" }),
    );
    const split = Math.ceil(logical.length / 2);
    for (const [index, bytes] of [
      logical.subarray(0, split),
      logical.subarray(split),
    ].entries()) {
      harness.stdout.write(
        `${JSON.stringify({
          type: "rpc_chunk",
          chunkId: "chunk-1",
          index,
          count: 2,
          byteLength: logical.length,
          data: bytes.toString("base64"),
        })}\n`,
      );
    }
    expect(callbacks.onEvent).toHaveBeenCalledWith({
      type: "message_update",
      messageId: "m1",
    });
    harness.stdout.write(
      `${JSON.stringify({
        type: "subagent_progress",
        subagentId: "worker-1",
      })}\n`,
    );
    expect(callbacks.onSubagent).toHaveBeenCalledWith({
      type: "subagent_progress",
      subagentId: "worker-1",
    });

    harness.exit(0);
  });

  it("rejects failed commands and advertised oversized chunks", async () => {
    const harness = fakeProcess();
    const callbacks = fakeCallbacks();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      callbacks,
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({
        type: "ready",
        supportedProtocolVersions: [2],
        maxReassembledFrameBytes: 8,
      })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: {},
      })}\n`,
    );
    await started;

    const state = client.getState();
    harness.stdout.write(
      `${JSON.stringify({ type: "response", id: "req_0", success: false, error: "state unavailable" })}\n`,
    );
    await expect(state).rejects.toThrow("state unavailable");

    harness.stdout.write(
      `${JSON.stringify({
        type: "rpc_chunk",
        chunkId: "too-large",
        index: 0,
        count: 1,
        byteLength: 9,
        data: Buffer.alloc(9).toString("base64"),
      })}\n`,
    );
    expect(callbacks.onLog).toHaveBeenCalledWith(
      "Ignoring invalid omp RPC chunk frame.",
    );

    harness.exit(0);
  });

  it("reassembles valid multi-byte UTF-8 across chunks", async () => {
    const harness = fakeProcess();
    const callbacks = fakeCallbacks();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      callbacks,
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [2] })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: {},
      })}\n`,
    );
    await started;

    const logical = Buffer.from(
      JSON.stringify({ type: "message_update", text: "héllo 世界" }),
      "utf8",
    );
    const split = Math.ceil(logical.length / 2);
    for (const [index, bytes] of [
      logical.subarray(0, split),
      logical.subarray(split),
    ].entries()) {
      harness.stdout.write(
        `${JSON.stringify({
          type: "rpc_chunk",
          chunkId: "chunk-utf8",
          index,
          count: 2,
          byteLength: logical.length,
          data: bytes.toString("base64"),
        })}\n`,
      );
    }
    expect(callbacks.onEvent).toHaveBeenCalledWith({
      type: "message_update",
      text: "héllo 世界",
    });
    harness.exit(0);
  });

  it("rejects reassembled frames with malformed UTF-8", async () => {
    const harness = fakeProcess();
    const callbacks = fakeCallbacks();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      callbacks,
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [2] })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: {},
      })}\n`,
    );
    await started;

    // 0xFF is never valid UTF-8; it must be rejected, not decoded with U+FFFD.
    const malformed = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]);
    harness.stdout.write(
      `${JSON.stringify({
        type: "rpc_chunk",
        chunkId: "chunk-bad-utf8",
        index: 0,
        count: 1,
        byteLength: malformed.length,
        data: malformed.toString("base64"),
      })}\n`,
    );
    expect(callbacks.onLog).toHaveBeenCalledWith(
      "Rejecting omp RPC chunk frame with malformed UTF-8.",
    );
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    harness.exit(0);
  });

  it("merges extra env variables into the omp child environment", async () => {
    const harness = fakeProcess();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        env: { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-other" },
        spawn: harness.spawn,
      },
      fakeCallbacks(),
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [2] })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: {},
      })}\n`,
    );
    await started;

    expect(harness.spawn).toHaveBeenCalledWith(
      "omp",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          OPENAI_API_KEY: "sk-test",
          ANTHROPIC_API_KEY: "sk-other",
          PATH: process.env.PATH,
        }),
      }),
    );
    harness.exit(0);
  });

  it("attaches the omp stderr tail to a start failure exit error", async () => {
    const harness = fakeProcess();
    const callbacks = fakeCallbacks();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      callbacks,
    );
    const started = client.start();

    harness.stderr.write(
      "No models available. Use /login or set an API key environment variable.\n",
    );
    harness.exit(1);

    await expect(started).rejects.toThrow("omp RPC process exited with code 1");
    await expect(started).rejects.toThrow("No models available");
    expect(callbacks.onClosed).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("No models"),
      }),
    );
  });

  it("rejects a server advertising only newer protocol versions", async () => {
    const harness = fakeProcess();
    const callbacks = fakeCallbacks();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      callbacks,
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [3] })}\n`,
    );
    await expect(started).rejects.toThrow(
      /protocol incompatibility.*advertises 3.*supports protocol 1\.\.2/,
    );
    // A capability failure is fatal: no crash-recovery retry signal.
    expect(callbacks.onClosed).not.toHaveBeenCalled();
    expect(client.capabilities()).toBeUndefined();
  });

  it("fails closed when the server explicitly disables host tools", async () => {
    const harness = fakeProcess();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      fakeCallbacks(),
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({
        type: "ready",
        supportedProtocolVersions: [1, 2],
        hostTools: false,
      })}\n`,
    );
    await expect(started).rejects.toThrow(
      /host tools are disabled.*LHIC requires them/,
    );
  });

  it("exposes negotiated capabilities after ready", async () => {
    const harness = fakeProcess();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      fakeCallbacks(),
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({
        type: "ready",
        supportedProtocolVersions: [1, 2],
        hostTools: true,
        hostToolCancellation: true,
        interruptModes: ["immediate"],
      })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: {},
      })}\n`,
    );
    await started;
    expect(client.capabilities()).toEqual({
      rpcProtocolVersion: 2,
      hostTools: "supported",
      hostToolCancellation: "supported",
      // Never invented: absent advertisements are unknown, not supported.
      subagentEvents: "unknown",
      sessionSwitch: "unknown",
      interruptModes: "supported",
      interruptModeValues: ["immediate"],
    });
    harness.exit(0);
  });

  it("reports absent feature advertisements as unknown", async () => {
    const harness = fakeProcess();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      fakeCallbacks(),
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: {},
      })}\n`,
    );
    await started;
    expect(client.capabilities()).toEqual({
      rpcProtocolVersion: 2,
      hostTools: "unknown",
      hostToolCancellation: "unknown",
      subagentEvents: "unknown",
      sessionSwitch: "unknown",
      interruptModes: "unknown",
      interruptModeValues: [],
    });
    harness.exit(0);
  });

  it("fails startup when the server rejects protocol negotiation", async () => {
    const harness = fakeProcess();
    const callbacks = fakeCallbacks();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      callbacks,
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: false,
        error: "protocol v2 unavailable",
      })}\n`,
    );
    await expect(started).rejects.toThrow(
      /protocol negotiation failed.*protocol v2 unavailable/,
    );
    // A negotiation failure is fatal: no crash-recovery retry signal.
    expect(callbacks.onClosed).not.toHaveBeenCalled();
  });

  it("fails startup on a malformed negotiation acknowledgement", async () => {
    const harness = fakeProcess();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        spawn: harness.spawn,
      },
      fakeCallbacks(),
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`,
    );
    harness.stdout.write(
      `${JSON.stringify({
        id: "protocol-1",
        type: "response",
        success: true,
        data: { protocolVersion: 3 },
      })}\n`,
    );
    await expect(started).rejects.toThrow(
      /negotiation mismatch.*requested v2.*acknowledged v3/,
    );
  });

  it("fails startup when protocol negotiation times out", async () => {
    const harness = fakeProcess();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        negotiationTimeoutMs: 25,
        spawn: harness.spawn,
      },
      fakeCallbacks(),
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`,
    );
    await expect(started).rejects.toThrow(/negotiation timed out/);
  });

  it("honors the max protocol version cap", async () => {
    const harness = fakeProcess();
    const client = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        maxRpcProtocolVersion: 1,
        spawn: harness.spawn,
      },
      fakeCallbacks(),
    );
    const started = client.start();
    harness.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`,
    );
    await started;
    expect(client.capabilities()?.rpcProtocolVersion).toBe(1);
    expect(
      harness.writes().some((frame) => frame.type === "negotiate_protocol"),
    ).toBe(false);
    harness.exit(0);

    const incompatible = fakeProcess();
    const capped = new OmpRpcClient(
      {
        binary: "omp",
        workspaceRoot: "/workspace",
        sessionDir: "/sessions",
        maxRpcProtocolVersion: 1,
        spawn: incompatible.spawn,
      },
      fakeCallbacks(),
    );
    const cappedStart = capped.start();
    incompatible.stdout.write(
      `${JSON.stringify({ type: "ready", supportedProtocolVersions: [2] })}\n`,
    );
    await expect(cappedStart).rejects.toThrow(/protocol incompatibility/);
  });
});

function fakeCallbacks(): OmpRpcClientCallbacks {
  return {
    onEvent: vi.fn(),
    onSubagent: vi.fn(),
    onUiRequest: vi.fn(),
    onHostToolCall: vi.fn(),
    onClosed: vi.fn(),
    onLog: vi.fn(),
  };
}

function fakeProcess(): {
  spawn: typeof nodeSpawn;
  stdout: PassThrough;
  stderr: PassThrough;
  writes(): Array<Record<string, unknown>>;
  exit(code: number): void;
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (chunk) => written.push(String(chunk)));
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess;
  const spawn = vi.fn(() => child) as unknown as typeof nodeSpawn;
  return {
    spawn,
    stdout,
    stderr,
    writes: () =>
      written
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    exit: (code) => emitter.emit("exit", code, null),
  };
}
