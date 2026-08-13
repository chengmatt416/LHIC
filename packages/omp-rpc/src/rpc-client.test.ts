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
