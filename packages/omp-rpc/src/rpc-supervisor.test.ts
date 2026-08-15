import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  OmpRpcClient,
  OmpRpcClientCallbacks,
  OmpRpcClientOptions,
} from "./rpc-client.js";
import { OmpRpcSupervisor } from "./rpc-supervisor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

class FakeClient {
  public readonly prompts: string[] = [];
  public readonly switchedSessions: string[] = [];
  public hostTools = 0;
  public subscription: string | undefined;
  public closed = false;
  public promptBehavior: (message: string) => Promise<Record<string, unknown>> =
    async () => ({ accepted: true });

  public constructor(public readonly callbacks: OmpRpcClientCallbacks) {}

  public async start(): Promise<void> {}

  public async close(): Promise<void> {
    this.closed = true;
  }

  public async prompt(message: string): Promise<Record<string, unknown>> {
    this.prompts.push(message);
    return this.promptBehavior(message);
  }

  public async switchSession(
    sessionPath: string,
  ): Promise<Record<string, unknown>> {
    this.switchedSessions.push(sessionPath);
    return { sessionPath };
  }

  public async getState(): Promise<Record<string, unknown>> {
    return {
      sessionPath: this.switchedSessions.at(-1) ?? "/sessions/current.jsonl",
    };
  }

  public async setHostTools(): Promise<Record<string, unknown>> {
    this.hostTools += 1;
    return {};
  }

  public async setSubagentSubscription(
    level: string,
  ): Promise<Record<string, unknown>> {
    this.subscription = level;
    return {};
  }

  public crash(error = new Error("fake omp crash")): void {
    this.callbacks.onClosed(error);
  }

  public hostTool(id: string): void {
    this.callbacks.onHostToolCall({ type: "host_tool_call", id });
  }

  public event(frame: Record<string, unknown>): void {
    this.callbacks.onEvent(frame);
  }
}

async function fixture() {
  const stateDirectory = await mkdtemp(join(tmpdir(), "lhic-rpc-supervisor-"));
  temporaryDirectories.push(stateDirectory);
  const clients: FakeClient[] = [];
  const clientOptions: OmpRpcClientOptions[] = [];
  const events: Array<Record<string, unknown>> = [];
  const closed: Error[] = [];
  const supervisor = new OmpRpcSupervisor(
    {
      binary: "/fake/omp",
      workspaceRoot: "/workspace",
      sessionDir: "/sessions",
      stateDirectory,
      restartBackoffMs: [0, 0],
      clientFactory: (
        options: OmpRpcClientOptions,
        callbacks: OmpRpcClientCallbacks,
      ) => {
        clientOptions.push({ ...options });
        const client = new FakeClient(callbacks);
        clients.push(client);
        return client as unknown as OmpRpcClient;
      },
    },
    {
      onEvent: (event) => events.push(event),
      onUiRequest: () => undefined,
      onHostToolCall: () => undefined,
      onClosed: (error) => {
        if (error) closed.push(error);
      },
      onLog: () => undefined,
    },
  );
  await supervisor.start();
  await supervisor.switchSession("/sessions/current.jsonl");
  return {
    supervisor,
    clients,
    clientOptions,
    events,
    closed,
    stateDirectory,
  };
}

function recoveryStates(events: Array<Record<string, unknown>>): unknown[] {
  return events
    .filter((event) => event.type === "rpc_recovery")
    .map((event) => event.state);
}

describe("OmpRpcSupervisor", () => {
  it("replays a prompt once when the process dies before acknowledgement", async () => {
    const { supervisor, clients, events, stateDirectory } = await fixture();
    clients[0]!.promptBehavior = async () => {
      clients[0]!.crash();
      throw new Error("closed before acknowledgement");
    };

    await expect(supervisor.prompt("continue the task")).resolves.toEqual({
      accepted: true,
    });

    expect(clients).toHaveLength(2);
    expect(clients[0]!.prompts).toEqual(["continue the task"]);
    expect(clients[1]!.prompts).toEqual(["continue the task"]);
    expect(clients[1]!.switchedSessions).toEqual(["/sessions/current.jsonl"]);
    expect(recoveryStates(events)).toEqual([
      "running",
      "restarting",
      "resumed",
    ]);
    const persisted = JSON.parse(
      await readFile(join(stateDirectory, "rpc-supervisor.json"), "utf8"),
    ) as { pendingPrompt?: { acknowledged?: boolean } };
    expect(persisted.pendingPrompt?.acknowledged).toBe(true);
    await supervisor.close();
  });

  it("does not replay a prompt acknowledged before a later crash", async () => {
    const { supervisor, clients, events, closed } = await fixture();
    await expect(supervisor.prompt("safe prompt")).resolves.toEqual({
      accepted: true,
    });

    clients[0]!.crash();
    await vi.waitFor(() => {
      expect(recoveryStates(events)).toContain("resumed");
    });

    expect(clients).toHaveLength(2);
    expect(clients[0]!.prompts).toEqual(["safe prompt"]);
    expect(clients[1]!.prompts).toEqual([]);
    expect(closed).toEqual([]);
    await supervisor.close();
  });

  it("never replays a prompt or host-tool result across a host call crash", async () => {
    const { supervisor, clients, events } = await fixture();
    clients[0]!.promptBehavior = async () => {
      clients[0]!.hostTool("host-1");
      clients[0]!.crash();
      throw new Error("closed during host tool call");
    };

    await expect(supervisor.prompt("use the desktop")).rejects.toThrow(
      "closed during host tool call",
    );
    await vi.waitFor(() => {
      expect(recoveryStates(events)).toContain("resumed");
    });

    expect(clients).toHaveLength(2);
    expect(clients[1]!.prompts).toEqual([]);
    expect(supervisor.snapshot().pendingHostToolIds).toEqual(["host-1"]);
    await supervisor.close();
  });

  it("persists structured subagent progress through restart", async () => {
    const { supervisor, clients } = await fixture();
    clients[0]!.event({
      type: "subagent_progress",
      subagentId: "worker-1",
      status: "running",
      progress: "Inspecting tests",
    });
    clients[0]!.crash();
    await vi.waitFor(() => {
      expect(clients).toHaveLength(2);
    });

    expect(supervisor.snapshot().subagents["worker-1"]).toMatchObject({
      status: "running",
      progress: "Inspecting tests",
    });
    await supervisor.close();
  });

  it("restarts with an exact extension pool and restores runtime bindings", async () => {
    const { supervisor, clients, clientOptions, events } = await fixture();
    await supervisor.setHostTools([
      { name: "host", label: "Host", description: "Host" },
    ]);
    await supervisor.setSubagentSubscription("events");

    await supervisor.restartWithExtensionRoots([
      "/state/model pool",
      "/state/another;pool",
    ]);

    expect(clients).toHaveLength(2);
    expect(clients[0]!.closed).toBe(true);
    expect(clientOptions[1]!.extensionRoots).toEqual([
      "/state/model pool",
      "/state/another;pool",
    ]);
    expect(clients[1]!.hostTools).toBe(1);
    expect(clients[1]!.subscription).toBe("events");
    expect(clients[1]!.switchedSessions).toEqual(["/sessions/current.jsonl"]);
    expect(recoveryStates(events)).toEqual(["running", "resumed"]);
    await supervisor.close();
  });
});
