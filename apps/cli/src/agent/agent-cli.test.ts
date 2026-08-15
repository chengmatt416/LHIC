import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgentCommand } from "./agent-cli.js";
import { resolveOmpBinary } from "./omp-binary.js";

const fakeOmpSource = `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const rl = createInterface({ input: process.stdin });
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
emit({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  if (process.env.FAKE_OMP_LOG) {
    appendFileSync(process.env.FAKE_OMP_LOG, frame.type + "\\n");
  }
  if (frame.type === "negotiate_protocol") {
    emit({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
  } else if (frame.type === "set_host_tools") {
    emit({ id: frame.id, type: "response", command: frame.type, success: true, data: { toolNames: (frame.tools ?? []).map((t) => t.name) } });
  } else if (frame.type === "prompt") {
    emit({ id: frame.id, type: "response", command: "prompt", success: true, data: { agentInvoked: true } });
    emit({ type: "agent_start" });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hello " }, message: { role: "assistant", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "from fake omp" }, message: { role: "assistant", content: [] } });
    emit({ type: "agent_end", messages: [], isTerminal: true });
  } else {
    emit({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
  }
});
rl.on("close", () => process.exit(0));
`;

describe("lhic agent (omp RPC pipeline)", () => {
  let directory: string;
  let binary: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-agent-test-"));
    binary = join(directory, "fake-omp");
    await writeFile(binary, fakeOmpSource);
    await chmod(binary, 0o755);
  });

  afterEach(async () => {
    delete process.env.OMP_BINARY;
    delete process.env.OMP_BINARY_DIGEST;
    delete process.env.OMP_BINARY_VERSION;
    delete process.env.OMP_BINARY_TRUST;
    await rm(directory, { recursive: true, force: true });
  });

  it("runs a one-shot prompt and renders the streamed assistant text", async () => {
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    const exitCode = await runAgentCommand({
      prompt: "Reply with hello",
      binary,
      output,
      sessionDir: join(directory, "sessions"),
    });
    const rendered = chunks.join("");
    expect(rendered).toContain("Hello from fake omp");
    expect(rendered).toContain("agent running");
    expect(rendered).toContain("agent finished");
    expect(exitCode).toBe(0);
  });

  it("honors an OMP_BINARY override with an explicit trust mode", async () => {
    process.env.OMP_BINARY = binary;
    process.env.OMP_BINARY_TRUST = "development-only";
    const resolved = await resolveOmpBinary();
    expect(resolved.path).toBe(binary);
    expect(resolved.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved.trustSource).toBe("explicit-operator");
  });

  it("registers the approval-gated LHIC host tools with the agent", async () => {
    const logPath = join(directory, "frames.log");
    process.env.FAKE_OMP_LOG = logPath;
    const chunks: string[] = [];
    const output = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(String(chunk));
        callback();
      },
    });
    await runAgentCommand({
      prompt: "hello",
      binary,
      output,
      sessionDir: join(directory, "sessions"),
    });
    delete process.env.FAKE_OMP_LOG;
    const frames = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(frames).toContain("set_host_tools");
    expect(frames).toContain("negotiate_protocol");
    expect(frames).toContain("prompt");
  });
});
