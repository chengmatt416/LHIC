import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { message?: string };
}

interface PendingRequest {
  resolve: (response: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

class StdioMcpClient {
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private outputBuffer = "";
  private stderr = "";

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    child.on("error", (error) => this.rejectPending(error));
    child.on("exit", (code, signal) => {
      if (this.pending.size > 0) {
        this.rejectPending(
          new Error(
            `MCP server exited before responding (${code ?? signal}). ${this.stderr}`,
          ),
        );
      }
    });
  }

  public request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Timed out waiting for MCP ${method}. ${this.stderr}`),
        );
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  public notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
    );
  }

  public async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return;
    }
    const exited = new Promise<void>((resolve) => {
      this.child.once("exit", () => resolve());
    });
    this.child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await exited;
    }
  }

  private onStdout(chunk: Buffer): void {
    this.outputBuffer += chunk.toString();
    const lines = this.outputBuffer.split("\n");
    this.outputBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) {
        continue;
      }
      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        if (typeof response.id !== "number") {
          continue;
        }
        const pending = this.pending.get(response.id);
        if (!pending) {
          continue;
        }
        this.pending.delete(response.id);
        clearTimeout(pending.timeout);
        pending.resolve(response);
      } catch (error) {
        this.rejectPending(
          new Error(
            `MCP server wrote malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

describe("LHIC computer-use MCP stdio entrypoint", () => {
  it("negotiates tools and controls a real headless browser process", async () => {
    const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const compiledEntrypoint = join(
      workspaceRoot,
      "apps/mcp-server/dist/index.js",
    );
    const entrypointArgs = existsSync(compiledEntrypoint)
      ? [compiledEntrypoint]
      : ["--import", "tsx", "apps/mcp-server/src/index.ts"];
    const child = spawn(process.execPath, entrypointArgs, {
      cwd: workspaceRoot,
      env: { ...process.env, LHIC_MCP_HEADLESS: "true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new StdioMcpClient(child);

    try {
      const initialize = await client.request("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "lhic-stdio-test", version: "0.1.0" },
      });
      expect(initialize.error).toBeUndefined();
      client.notify("notifications/initialized");

      const tools = await client.request("tools/list", {});
      expect(tools.error).toBeUndefined();
      expect(tools.result).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "lhic_browser_start" }),
          expect.objectContaining({ name: "lhic_browser_act" }),
          expect.objectContaining({ name: "lhic_runtime_status" }),
          expect.objectContaining({ name: "lhic_skills_list" }),
          expect.objectContaining({ name: "lhic_selector_memory_list" }),
        ]),
      });

      const start = await client.request("tools/call", {
        name: "lhic_browser_start",
        arguments: {},
      });
      expect(start.error).toBeUndefined();
      expect(start.result).not.toMatchObject({ isError: true });

      const close = await client.request("tools/call", {
        name: "lhic_browser_close",
        arguments: {},
      });
      expect(close.error).toBeUndefined();
      expect(close.result).not.toMatchObject({ isError: true });
    } finally {
      await client.close();
    }
  }, 30_000);
});
