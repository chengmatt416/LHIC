import { createInterface, type ReadLine } from "node:readline";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  OmpRpcClient,
  lhicHostToolDefinitions,
} from "@lhic/omp-rpc";

import { resolveOmpBinary, ompCacheDirectory } from "./omp-binary.js";
import {
  CliHostRunner,
  type TaskProposalSummary,
} from "./cli-host-runner.js";

export interface AgentCliOptions {
  /** One-shot prompt; when set the agent runs it and exits. */
  prompt?: string;
  workspaceRoot?: string;
  sessionDir?: string;
  approvedBy?: string;
  binary?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
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
  const binary = options.binary ?? (await resolveOmpBinary());
  const output = options.output ?? process.stdout;
  const input = options.input ?? process.stdin;
  const oneShot = options.prompt !== undefined;
  let streaming = false;
  let inAssistantText = false;
  let turnSettled: (() => void) | undefined;

  const write = (text: string): void => {
    output.write(text);
  };

  const line = (text: string): void => write(`${text}\n`);

  const client = new OmpRpcClient(
    {
      binary,
      workspaceRoot,
      sessionDir,
      ...(oneShot ? { args: ["--approval-mode", "write"] } : {}),
    },
    {
      onEvent: (frame) => {
        switch (frame.type) {
          case "agent_start":
            streaming = true;
            line("");
            line(`${levelColors.dim}── agent running ──${levelColors.reset}`);
            break;
          case "agent_end":
            streaming = false;
            if (inAssistantText) {
              write("\n");
              inAssistantText = false;
            }
            line(`${levelColors.dim}── agent finished ──${levelColors.reset}`);
            if (frame.isTerminal !== false) {
              turnSettled?.();
            }
            break;
          case "message_update": {
            const assistantEvent = frame.assistantMessageEvent as
              | { type?: string; delta?: unknown }
              | undefined;
            if (
              assistantEvent?.type === "text_delta" &&
              typeof assistantEvent.delta === "string"
            ) {
              inAssistantText = true;
              write(assistantEvent.delta);
            }
            break;
          }
          case "message": {
            const message = frame.message as
              | { role?: string; text?: string }
              | undefined;
            if (message?.text) {
              if (message.role === "assistant") {
                if (!inAssistantText) write("\n");
                write(message.text);
                write("\n");
                inAssistantText = false;
              } else {
                line(`\n${levelColors.bold}you${levelColors.reset}: ${message.text}`);
              }
            }
            break;
          }
          case "extension_error":
            line(
              `${levelColors.error}agent error: ${String(frame.error ?? "unknown")}${levelColors.reset}`,
            );
            turnSettled?.();
            break;
          default:
            break;
        }
      },
      onUiRequest: (frame) => {
        void handleUiRequest(frame).catch((error: unknown) =>
          line(`${levelColors.error}${String(error)}${levelColors.reset}`),
        );
      },
      onHostToolCall: (frame) => hostRunner.handleHostToolCall(frame),
      onClosed: (error) => {
        if (error) {
          line(`${levelColors.error}omp closed: ${error.message}${levelColors.reset}`);
        }
        turnSettled?.();
      },
      onLog: (logLine) => {
        process.stderr.write(logLine);
      },
    },
  );

  const hostRunner = new CliHostRunner({
    workspaceRoot,
    ...(options.approvedBy ? { approvedBy: options.approvedBy } : {}),
    promptApproval: (toolName, proposal) => promptApproval(toolName, proposal),
    emitResult: (callId, result, isError) =>
      client.hostToolResult(callId, result, isError),
    emitUpdate: (callId, partialResult) =>
      client.hostToolUpdate(callId, partialResult),
  });

  const promptApproval = async (
    toolName: string,
    proposal: TaskProposalSummary,
  ): Promise<{ approved: boolean; approvedBy: string }> => {
    line("");
    line(
      `${levelColors.bold}${toolName}${levelColors.reset} — ${proposal.stepCount} step${proposal.stepCount === 1 ? "" : "s"} require approval:`,
    );
    for (const step of proposal.steps) {
      line(
        `  ${levelColors.dim}${step.id}${levelColors.reset} ${step.intent} [${step.action}] risk=${step.riskLevel} verifier="${step.verifier}"`,
      );
    }
    const answer = await ask("Approve? [y/N] ");
    if (!answer.trim().toLocaleLowerCase().startsWith("y")) {
      return { approved: false, approvedBy: "" };
    }
    const name = (
      options.approvedBy ??
      (await ask("Approved by: ")).trim() ??
      ""
    ).trim();
    return { approved: true, approvedBy: name || "cli-operator" };
  };

  const handleUiRequest = async (frame: Record<string, unknown>): Promise<void> => {
    const id = String(frame.id ?? "");
    const method = String(frame.method ?? "notify");
    const title = String(frame.title ?? "The agent needs input");
    if (method === "notify" || method === "setStatus" || method === "setWidget") {
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
            const record = model as { provider?: string; modelId?: string; id?: string };
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
            line(`${levelColors.bold}${phase.name ?? "Todos"}${levelColors.reset}`);
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

  const ask = (question: string): Promise<string> => {
    const { promise, resolve: resolveAnswer } = Promise.withResolvers<string>();
    const rl: ReadLine = createInterface({ input, output });
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(answer);
    });
    return promise;
  };

  await client.start();
  await client.setHostTools(lhicHostToolDefinitions());

  if (oneShot) {
    const { promise: settled, resolve: settleTurn } =
      Promise.withResolvers<void>();
    turnSettled = settleTurn;
    const result = await client.prompt(options.prompt!, "followUp");
    const agentInvoked = result.agentInvoked;
    if (agentInvoked === false) {
      // Local-only completion (slash command inside the prompt).
      await client.close();
      await hostRunner.close();
      return 0;
    }
    await Promise.race([
      settled,
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 600_000)),
    ]);
    await client.close();
    await hostRunner.close();
    return 0;
  }

  line(
    `${levelColors.bold}LHIC agent${levelColors.reset} — omp coding agent. Type /help for commands, Ctrl-C to abort.`,
  );
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
      }
    }
  }
  await client.close();
  await hostRunner.close();
  return 0;
}

const agentUsage = `Commands:
  <message>            send a prompt (while the agent runs, it steers)
  /help                this help
  /new                 start a new session
  /sessions            list saved sessions
  /switch <n|path>     switch to a saved session
  /model [p/id]        list models, or set the active model
  /thinking <level>    off|minimal|low|medium|high|xhigh|max
  /fast [on|off]       toggle fast mode
  /todos               show the current todo list
  /export              export the session as HTML
  /abort               abort the running agent
  /exit                quit`;
