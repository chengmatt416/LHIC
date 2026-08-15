import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { SideEffectLedger, WorkspaceConflictStore } from "@lhic/ledger";
import {
  OmpActionReceiptObserver,
  OmpRpcSupervisor,
  OmpWorkspaceObserver,
  SubagentModelPool,
  parseModelCatalog,
  type OmpSubagentModel,
} from "@lhic/omp-rpc";
import { receiptLogPath } from "@lhic/trace";

import {
  resolveOmpBinary,
  ompCacheDirectory,
  type OmpVersionPolicy,
} from "./omp-binary.js";
import {
  CliHostRunner,
  hostToolDefinitions,
  type HostApprovalRequest,
} from "./cli-host-runner.js";
import { InputArbiter, InputClosedError } from "./input-arbiter.js";
import { ReceiptRecorder } from "./receipt-recorder.js";

export interface AgentCliOptions {
  /** One-shot prompt; when set the agent runs it and exits. */
  prompt?: string;
  workspaceRoot?: string;
  sessionDir?: string;
  session?: string;
  model?: string;
  thinking?: string;
  subagentModels?: string[];
  fast?: boolean;
  jsonl?: boolean;
  approvedBy?: string;
  approvalPolicy?: "ask" | "deny" | "auto";
  binary?: string;
  /** omp binary version policy; benchmark/release runs MUST pin. */
  ompPolicy?: OmpVersionPolicy;
  /** Upper bound on the omp RPC protocol version to negotiate. */
  maxRpcProtocolVersion?: number;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
}

interface SessionInfo {
  path: string;
  name: string;
  messageCount: number;
  updatedAt: string;
}

const levelColors = {
  ok: "\u001b[32m",
  warn: "\u001b[33m",
  error: "\u001b[31m",
  dim: "\u001b[90m",
  reset: "\u001b[0m",
  bold: "\u001b[1m",
};

/**
 * `lhic agent` — a complete omp-based coding agent in the terminal:
 * interactive REPL (or one-shot), session management, model/thinking/fast
 * controls, streaming output, and the approval-gated LHIC browser/desktop
 * host tools.
 */
export async function runAgentCommand(
  options: AgentCliOptions = {},
): Promise<number> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const sessionDir =
    options.sessionDir ?? join(ompCacheDirectory(), "sessions");
  await mkdir(sessionDir, { recursive: true });
  const resolved =
    options.binary !== undefined
      ? { path: options.binary }
      : await resolveOmpBinary(options.ompPolicy);
  const binary = resolved.path;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const input = options.input ?? process.stdin;
  const oneShot = options.prompt !== undefined;
  const jsonl = options.jsonl === true;
  let streaming = false;
  let inAssistantText = false;
  let recoveryFailed = false;
  let turnSettled: (() => void) | undefined;
  let effectiveSubagentModels: OmpSubagentModel[] = [];
  const subagentModelsByAgent = new Map<string, OmpSubagentModel>();
  const inputArbiter = new InputArbiter(input, output);
  const write = (text: string): void => {
    output.write(text);
  };

  const line = (text: string): void => write(`${text}\n`);
  const record = (type: string, data: Record<string, unknown> = {}): void => {
    if (jsonl) line(JSON.stringify({ type, ...data }));
  };
  const taskId = `agent-${join(sessionDir).split(/[\\/]/).at(-1) ?? "session"}`;
  const traceDirectory = resolve(workspaceRoot, ".lhic/traces");
  const agentReceiptLog = receiptLogPath(traceDirectory, taskId);
  const receiptRecorder = new ReceiptRecorder(agentReceiptLog, taskId);
  const sideEffectLedger = new SideEffectLedger({
    databaseFile: join(traceDirectory, "ledger.sqlite"),
  });
  const conflictStore = new WorkspaceConflictStore({
    databaseFile: join(traceDirectory, "ledger.sqlite"),
  });
  const workspaceObserver = new OmpWorkspaceObserver({
    store: conflictStore,
    agentId: "lhic-agent",
    taskId,
    workspaceRoot,
    onConflict: (conflict) => {
      if (jsonl) {
        record("conflict", {
          conflictId: conflict.conflictId,
          path: conflict.path,
          oldHash: conflict.oldHash.slice(0, 12),
          newHash: conflict.newHash.slice(0, 12),
          writerAgentId: conflict.writerAgentId ?? "external",
        });
      } else {
        line(
          `${levelColors.warn}workspace conflict: ${conflict.path} changed by ${conflict.writerAgentId ?? "an external process"} after this agent read it (${conflict.oldHash.slice(0, 8)}… → ${conflict.newHash.slice(0, 8)}…); re-read before writing.${levelColors.reset}`,
        );
      }
    },
  });
  const ompReceiptObserver = new OmpActionReceiptObserver({
    taskId,
    receiptLogPath: agentReceiptLog,
  });
  const client = new OmpRpcSupervisor(
    {
      binary,
      workspaceRoot,
      sessionDir,
      stateDirectory: join(sessionDir, ".recovery"),
      ...(oneShot ? { args: ["--approval-mode", "write"] } : {}),
      ...(options.maxRpcProtocolVersion !== undefined
        ? { maxRpcProtocolVersion: options.maxRpcProtocolVersion }
        : {}),
    },
    {
      onEvent: (frame) => {
        ompReceiptObserver.feed(frame);
        workspaceObserver.feed(frame);
        switch (frame.type) {
          case "agent_start":
            streaming = true;
            if (jsonl) record("status", { status: "running" });
            else {
              line("");
              line(`${levelColors.dim}── agent running ──${levelColors.reset}`);
            }
            break;
          case "agent_end":
            streaming = false;
            if (inAssistantText) {
              if (!jsonl) write("\n");
              inAssistantText = false;
            }
            if (jsonl) record("status", { status: "completed" });
            else
              line(
                `${levelColors.dim}── agent finished ──${levelColors.reset}`,
              );
            if (frame.isTerminal !== false) turnSettled?.();
            break;
          case "message_update": {
            const assistantEvent = frame.assistantMessageEvent as
              { type?: string; delta?: unknown } | undefined;
            if (
              assistantEvent?.type === "text_delta" &&
              typeof assistantEvent.delta === "string"
            ) {
              inAssistantText = true;
              if (jsonl) {
                record("message", {
                  role: "assistant",
                  delta: assistantEvent.delta,
                });
              } else {
                write(assistantEvent.delta);
              }
            }
            break;
          }
          case "message": {
            const message = frame.message as
              { role?: string; text?: string } | undefined;
            if (message?.text) {
              if (jsonl) {
                record("message", {
                  role: message.role ?? "assistant",
                  text: message.text,
                });
              } else if (message.role === "assistant") {
                if (!inAssistantText) write("\n");
                write(`${message.text}\n`);
                inAssistantText = false;
              } else {
                line(
                  `\n${levelColors.bold}you${levelColors.reset}: ${message.text}`,
                );
              }
            }
            break;
          }
          case "tool_execution_start":
          case "tool_execution_update":
          case "tool_execution_end":
            if (jsonl) record("tool", { event: frame });
            break;
          case "subagent_lifecycle":
          case "subagent_progress":
          case "subagent_event": {
            const routed = withSubagentModel(frame, subagentModelsByAgent);
            if (jsonl) record("subagent", { event: routed });
            break;
          }
          case "rpc_recovery": {
            const recoveryState = String(frame.state ?? "restarting");
            if (recoveryState === "recovery_failed") {
              recoveryFailed = true;
              turnSettled?.();
            }
            if (jsonl) {
              record("status", { status: recoveryState });
            } else {
              line(
                `${levelColors.dim}omp recovery: ${recoveryState.replace("_", " ")}${levelColors.reset}`,
              );
            }
            break;
          }
          case "extension_error":
            if (jsonl) {
              record("error", { message: String(frame.error ?? "unknown") });
            } else {
              line(
                `${levelColors.error}agent error: ${String(frame.error ?? "unknown")}${levelColors.reset}`,
              );
            }
            turnSettled?.();
            break;
          default:
            break;
        }
      },
      onUiRequest: (frame) => {
        void handleUiRequest(frame).catch((error: unknown) => {
          if (jsonl) record("error", { message: String(error) });
          else line(`${levelColors.error}${String(error)}${levelColors.reset}`);
        });
      },
      onHostToolCall: (frame) => hostRunner.handleHostToolCall(frame),
      onClosed: (error) => {
        if (error) {
          if (jsonl) record("error", { message: error.message });
          else
            line(
              `${levelColors.error}omp closed: ${error.message}${levelColors.reset}`,
            );
        }
        turnSettled?.();
      },
      onLog: (logLine) => {
        errorOutput.write(logLine);
      },
    },
  );

  const hostRunner = new CliHostRunner({
    workspaceRoot,
    taskId,
    ...(options.approvedBy ? { approvedBy: options.approvedBy } : {}),
    approvalPolicy: options.approvalPolicy ?? (oneShot ? "deny" : "ask"),
    promptApproval,
    emitResult: (callId, result, isError) =>
      client.hostToolResult(callId, result, isError),
    emitUpdate: (callId, partialResult) =>
      client.hostToolUpdate(callId, partialResult),
    receiptRecorder,
    ledger: sideEffectLedger,
  });

  async function promptApproval(
    request: HostApprovalRequest,
  ): Promise<{ approved: false } | { approved: true; approvedBy: string }> {
    line("");
    line(
      `${levelColors.bold}${request.toolName}${levelColors.reset} — ${request.proposal.stepCount} step${request.proposal.stepCount === 1 ? "" : "s"} require approval:`,
    );
    for (const step of request.proposal.steps) {
      line(
        `  ${levelColors.dim}${step.id}${levelColors.reset} ${step.intent} [${step.action}] risk=${step.riskLevel} verifier="${step.verifier}"`,
      );
    }
    line(
      `  exact action: surface=${request.surface} hash=${request.actionHash} risk=${request.riskLevel} intent="${request.intent}" verifier="${request.verifier}"`,
    );
    const answer = await ask("Approve this exact action? [y/N] ");
    if (!answer.trim().toLocaleLowerCase().startsWith("y")) {
      return { approved: false };
    }
    const name = (
      options.approvedBy ??
      (await ask("Approved by: ")).trim() ??
      ""
    ).trim();
    return { approved: true, approvedBy: name || "cli-operator" };
  }

  const handleUiRequest = async (
    frame: Record<string, unknown>,
  ): Promise<void> => {
    const id = String(frame.id ?? "");
    const method = String(frame.method ?? "notify");
    const title = String(frame.title ?? "The agent needs input");
    if (
      method === "notify" ||
      method === "setStatus" ||
      method === "setWidget"
    ) {
      if (inAssistantText) {
        write("\n");
        inAssistantText = false;
      }
      write(`${levelColors.dim}${title}${levelColors.reset}\n`);
      return;
    }
    if (oneShot) {
      await client.uiResponse(id, { cancelled: true });
      return;
    }
    line(`${levelColors.bold}${title}${levelColors.reset}`);
    if (method === "confirm") {
      const answer = await ask(
        `${String(frame.message ?? "Continue?")} [y/N] `,
      );
      await client.uiResponse(id, {
        confirmed: answer.trim().toLocaleLowerCase().startsWith("y"),
      });
      return;
    }
    const value = await ask(String(frame.placeholder ?? "Response: "));
    await client.uiResponse(id, { value });
  };

  const listSessions = async (): Promise<SessionInfo[]> => {
    let files: string[];
    try {
      files = await readdir(sessionDir);
    } catch {
      return [];
    }
    const sessions: SessionInfo[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = resolve(sessionDir, file);
      const updatedAt = (await stat(path)).mtime.toISOString();
      sessions.push({
        path,
        name: basename(file, ".jsonl"),
        messageCount: 0,
        updatedAt,
      });
    }
    return sessions.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  };

  const runSlash = async (raw: string): Promise<boolean> => {
    const [command, ...rest] = raw.trim().slice(1).split(/\s+/);
    const arg = rest.join(" ");
    switch (command) {
      case "help":
        line(agentUsage);
        return true;
      case "exit":
      case "quit":
        return false;
      case "abort":
        await client.abort();
        return true;
      case "new":
        await client.newSession();
        line("New session started.");
        return true;
      case "sessions": {
        const sessions = await listSessions();
        if (sessions.length === 0) {
          line("No saved sessions.");
        } else {
          sessions.forEach((session, index) =>
            line(`${index + 1}. ${session.name} (${session.updatedAt})`),
          );
        }
        return true;
      }
      case "switch": {
        if (!arg) {
          line("Usage: /switch <session path or number>");
          return true;
        }
        const sessions = await listSessions();
        const target = /^\d+$/.test(arg)
          ? sessions[Number(arg) - 1]?.path
          : resolve(sessionDir, arg);
        if (!target) {
          line("Session not found.");
          return true;
        }
        await client.switchSession(target);
        line(`Switched to ${basename(target, ".jsonl")}.`);
        return true;
      }
      case "model": {
        if (!arg) {
          const data = await client.getAvailableModels();
          const models = Array.isArray(data.models) ? data.models : [];
          for (const model of models) {
            const record = model as {
              provider?: string;
              modelId?: string;
              id?: string;
            };
            line(`${record.provider}/${record.modelId ?? record.id ?? ""}`);
          }
          return true;
        }
        const [provider, ...modelParts] = arg.split("/");
        const modelId = modelParts.join("/");
        await client.setModel(provider!, modelId);
        line(`Model set to ${provider}/${modelId}.`);
        return true;
      }
      case "subagents": {
        if (rest[0] !== "models") {
          line("Usage: /subagents models");
          return true;
        }
        if (effectiveSubagentModels.length === 0) {
          line("No custom-agent models enabled.");
          return true;
        }
        for (const model of effectiveSubagentModels) {
          line(
            `${model.selector} (${model.agentName}; connected=${String(model.connected)})`,
          );
        }
        return true;
      }
      case "thinking": {
        if (!arg) {
          line("Usage: /thinking <off|minimal|low|medium|high|xhigh|max>");
          return true;
        }
        await client.setThinkingLevel(arg);
        line(`Thinking level set to ${arg}.`);
        return true;
      }
      case "fast": {
        const enabled = arg === "on" || arg === "1" || arg === "true";
        await client.setFastMode(arg === "off" ? false : enabled);
        line(`Fast mode ${arg === "off" ? "disabled" : "enabled"}.`);
        return true;
      }
      case "todos": {
        const state = await client.getState();
        const phases = Array.isArray(state.todoPhases)
          ? (state.todoPhases as Array<{
              name?: string;
              tasks?: Array<{ content?: string; status?: string }>;
            }>)
          : [];
        if (phases.length === 0) {
          line("No todos.");
        } else {
          for (const phase of phases) {
            line(
              `${levelColors.bold}${phase.name ?? "Todos"}${levelColors.reset}`,
            );
            for (const task of phase.tasks ?? []) {
              line(`  [${task.status ?? "pending"}] ${task.content ?? ""}`);
            }
          }
        }
        return true;
      }
      case "export": {
        const path = await client.exportHtml();
        line(`Exported to ${String(path ?? "session HTML")}.`);
        return true;
      }
      default:
        line(`Unknown command /${command}. Try /help.`);
        return true;
    }
  };

  const ask = (question: string): Promise<string> =>
    inputArbiter.question(question);

  await client.start();
  if (options.subagentModels !== undefined) {
    const catalog = parseModelCatalog(await client.getAvailableModels());
    const generated = await new SubagentModelPool(
      join(workspaceRoot, ".lhic", "omp", "model-pool"),
    ).generate(catalog, options.subagentModels);
    effectiveSubagentModels = generated.models;
    subagentModelsByAgent.clear();
    for (const model of generated.models) {
      subagentModelsByAgent.set(model.agentName, model);
    }
    await client.restartWithExtensionRoots(
      generated.models.length > 0 ? [generated.extensionRoot] : [],
    );
  }
  if (options.session) {
    const sessionPath =
      options.session === "last"
        ? (await listSessions())[0]?.path
        : resolve(sessionDir, options.session);
    if (!sessionPath) throw new Error("No saved agent session exists.");
    await client.switchSession(sessionPath);
    record("session", { path: sessionPath });
  }
  if (options.model) {
    const [provider, ...modelParts] = options.model.split("/");
    const modelId = modelParts.join("/");
    if (!provider || !modelId)
      throw new Error("Agent model must be provider/id.");
    await client.setModel(provider, modelId);
  }
  if (options.thinking) await client.setThinkingLevel(options.thinking);
  if (options.fast) await client.setFastMode(true);
  await client.setHostTools(hostToolDefinitions());
  await client.setSubagentSubscription("events");

  if (oneShot) {
    const { promise: settled, resolve: settleTurn } =
      Promise.withResolvers<void>();
    turnSettled = settleTurn;
    const result = await client.prompt(options.prompt!, "followUp");
    const agentInvoked = result.agentInvoked;
    if (agentInvoked === false) {
      inputArbiter.close();
      // Local-only completion (slash command inside the prompt).
      await client.close();
      await hostRunner.close();
      return 0;
    }
    await Promise.race([
      settled,
      new Promise<void>((resolveTimeout) =>
        setTimeout(resolveTimeout, 600_000),
      ),
    ]);
    inputArbiter.close();
    await client.close();
    await hostRunner.close();
    return recoveryFailed ? 4 : 0;
  }

  line(
    `${levelColors.bold}LHIC agent${levelColors.reset} — omp coding agent. Type /help for commands, Ctrl-C to abort.`,
  );
  try {
    for (;;) {
      const raw = await ask("agent> ");
      const text = raw.trim();
      if (!text) continue;
      if (text.startsWith("/")) {
        const continueLoop = await runSlash(text);
        if (!continueLoop) break;
        continue;
      }
      if (streaming) {
        await client.steer(text);
      } else {
        const { promise: settled, resolve: settleTurn } =
          Promise.withResolvers<void>();
        turnSettled = settleTurn;
        const result = await client.prompt(text, "followUp");
        if (result.agentInvoked === false) {
          line(`${levelColors.dim}(completed locally)${levelColors.reset}`);
        } else {
          await settled;
          if (recoveryFailed) break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof InputClosedError)) throw error;
    if (streaming) await client.abort().catch(() => undefined);
  }
  inputArbiter.close();
  await client.close();
  await hostRunner.close();
  return recoveryFailed ? 4 : 0;
}

const agentUsage = `Commands:
  <message>            send a prompt (while the agent runs, it steers)
  /help                this help
  /new                 start a new session
  /sessions            list saved sessions
  /switch <n|path>     switch to a saved session
  /model [p/id]        list models, or set the active model
  /thinking <level>    off|minimal|low|medium|high|xhigh|max
  /subagents models    list enabled custom-agent models
  /fast [on|off]       toggle fast mode
  /todos               show the current todo list
  /export              export the session as HTML
  /abort               abort the running agent
  /exit                quit`;

function withSubagentModel(
  frame: Record<string, unknown>,
  models: Map<string, OmpSubagentModel>,
): Record<string, unknown> {
  const agent = String(frame.agent ?? frame.label ?? "");
  const model = models.get(agent);
  if (!model) return frame;
  return {
    ...frame,
    provider: model.provider,
    model: model.modelId,
    selector: model.selector,
  };
}
