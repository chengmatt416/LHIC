import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type JSX,
} from "react";

import type {
  OmpMessageView,
  OmpModelInfo,
  OmpRuntimeState,
  OmpSessionInfo,
  OmpTodoPhase,
} from "../shared/contracts.js";
import {
  initialAgentViewState,
  reduceAgentEvent,
  type AgentViewState,
} from "./agent-model.js";

/**
 * Agent Studio: the omp RPC agent embedded as the landing surface. All model
 * and tool execution stays in the omp child or the approval-gated local
 * runners; this component only renders frames and forwards UI decisions.
 */
export function Agent({
  setNotice,
}: {
  setNotice: (value: string) => void;
}): JSX.Element {
  const [view, dispatch] = useReducer(
    reduceAgentEvent,
    undefined,
    initialAgentViewState,
  );
  const [draft, setDraft] = useState("");
  const [sessions, setSessions] = useState<OmpSessionInfo[]>([]);
  const [models, setModels] = useState<OmpModelInfo[]>([]);
  const [loginProviders, setLoginProviders] = useState<Array<{ id: string }>>(
    [],
  );
  const [earlier, setEarlier] = useState<OmpMessageView[]>([]);
  const [earlierCursor, setEarlierCursor] = useState<string>();
  const [uiValue, setUiValue] = useState("");
  const [dismissedUi, setDismissedUi] = useState<string>();
  const [dismissedHostTool, setDismissedHostTool] = useState<string>();
  const [approvedBy, setApprovedBy] = useState("");
  const [sessionName, setSessionName] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const state: AgentViewState = view;

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await window.lhic.omp.listSessions());
    } catch {
      // The agent may not be running yet; the drawer stays empty.
    }
  }, []);

  useEffect(() => {
    void window.lhic.omp
      .start()
      .then(() => {
        void window.lhic.omp
          .listModels()
          .then(setModels)
          .catch(() => undefined);
        void window.lhic.omp
          .loginProviders()
          .then(setLoginProviders)
          .catch(() => undefined);
        void window.lhic.omp
          .availableCommands()
          .then((commands) => dispatch({ type: "commands", commands }))
          .catch(() => undefined);
      })
      .catch((error: unknown) => {
        setNotice(`Agent engine unavailable: ${message(error)}`);
      });
    void refreshSessions();
    return window.lhic.events.onOmp((event) => {
      dispatch(event);
      if (event.type === "message" || event.type === "delta") {
        void scrollToBottom();
      }
    });
  }, []);

  useEffect(() => {
    if (state.runtime?.sessionName) {
      setSessionName(state.runtime.sessionName);
    }
  }, [state.runtime?.sessionName]);

  useEffect(() => {
    void scrollToBottom();
  }, [state.messages]);

  const send = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await window.lhic.omp.prompt(text);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const steer = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await window.lhic.omp.steer(text);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const followUp = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    try {
      await window.lhic.omp.followUp(text);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const loadEarlier = async () => {
    try {
      const page = await window.lhic.omp.messages(earlierCursor);
      setEarlier((previous) => dedupeMessages([...page.messages, ...previous]));
      setEarlierCursor(page.nextCursor);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const renameSession = async () => {
    const name = sessionName.trim();
    if (!name) {
      setNotice("A session name is required.");
      return;
    }
    try {
      await window.lhic.omp.renameSession(name);
      await refreshSessions();
      setNotice(`Session renamed to "${name}".`);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const setThinkingLevel = async (level: string) => {
    try {
      const runtime = await window.lhic.omp.setThinkingLevel(
        level as NonNullable<OmpRuntimeState["thinkingLevel"]>,
      );
      dispatch({ type: "state", state: runtime });
      setNotice(`Thinking level set to ${level}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const setFastMode = async (enabled: boolean) => {
    try {
      const runtime = await window.lhic.omp.setFastMode(enabled);
      dispatch({ type: "state", state: runtime });
      setNotice(enabled ? "Fast mode enabled." : "Fast mode disabled.");
    } catch (error) {
      setNotice(message(error));
    }
  };

  const setInterruptMode = async (mode: string) => {
    try {
      const runtime = await window.lhic.omp.setInterruptMode(
        mode as "immediate" | "wait",
      );
      dispatch({ type: "state", state: runtime });
      setNotice(`Interrupt mode set to ${mode}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const insertCommand = (command: string) => {
    setDraft((current) => {
      const prefix = current.trimStart().startsWith("/") ? current : `/${command} `;
      return prefix;
    });
  };

  const abort = async () => {
    try {
      await window.lhic.omp.abort();
    } catch (error) {
      setNotice(message(error));
    }
  };

  const newSession = async () => {
    try {
      await window.lhic.omp.newSession();
      await refreshSessions();
    } catch (error) {
      setNotice(message(error));
    }
  };

  const switchSession = async (path: string) => {
    try {
      await window.lhic.omp.switchSession(path);
      setDraft("");
      setUiValue("");
      await refreshSessions();
    } catch (error) {
      setNotice(message(error));
    }
  };

  const changeModel = async (value: string) => {
    const [provider, ...rest] = value.split("/");
    const modelId = rest.join("/");
    if (!provider || !modelId) return;
    try {
      const runtime = await window.lhic.omp.setModel(provider, modelId);
      dispatch({ type: "state", state: runtime });
      setNotice(`Agent model switched to ${provider}/${modelId}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const exportHtml = async () => {
    try {
      const path = await window.lhic.omp.exportHtml();
      setNotice(`Session exported to ${path}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const login = async (providerId: string) => {
    try {
      await window.lhic.omp.login(providerId);
      setNotice("Login opened in your browser; complete it there.");
    } catch (error) {
      setNotice(message(error));
    }
  };

  const respondUi = async (response: {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
  }) => {
    const request = state.uiRequest;
    if (!request) return;
    setDismissedUi(request.id);
    try {
      await window.lhic.omp.respondUi(request.id, response);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const approveHostTool = async () => {
    const call = state.hostToolCall;
    if (!call) return;
    setDismissedHostTool(call.id);
    try {
      await window.lhic.omp.approveHostTool(call.id, approvedBy || "desktop-user");
    } catch (error) {
      setNotice(message(error));
    }
  };

  const rejectHostTool = async () => {
    const call = state.hostToolCall;
    if (!call) return;
    setDismissedHostTool(call.id);
    try {
      await window.lhic.omp.rejectHostTool(call.id);
    } catch (error) {
      setNotice(message(error));
    }
  };

  const runtime = state.runtime;
  const modelValue = runtime?.model
    ? `${runtime.model.provider}/${runtime.model.id}`
    : "";

  return (
    <div className="agent-grid">
      <aside className="panel agent-sessions" aria-label="Agent sessions">
        <div className="panel-title">
          <div>
            <span>SESSIONS</span>
            <h2>History</h2>
          </div>
          <button className="button" onClick={() => void newSession()}>
            New session
          </button>
        </div>
        {sessions.length === 0 ? (
          <p className="muted">No saved sessions yet.</p>
        ) : (
          <div className="table">
            {sessions.map((session) => (
              <button
                className="table-row agent-session-row"
                key={session.path}
                onClick={() => void switchSession(session.path)}
              >
                <strong>{session.name}</strong>
                <span>{session.messageCount} messages</span>
                <small>{formatTimestamp(session.updatedAt)}</small>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className="panel agent-chat" aria-label="Agent conversation">
        <div className="agent-chat-toolbar">
          {state.messages.length + earlier.length > 0 ? (
            <span className="agent-message-count">
              {earlier.length + state.messages.length} of{" "}
              {runtime?.messageCount ?? 0} messages
            </span>
          ) : null}
          {runtime &&
          runtime.messageCount > earlier.length + state.messages.length ? (
            <button className="button" onClick={() => void loadEarlier()}>
              Load earlier
            </button>
          ) : null}
        </div>
        {state.messages.length === 0 && earlier.length === 0 ? (
          <div className="agent-empty">
            <span className="eyebrow">OMP AGENT CORE</span>
            <h2>Agent Studio</h2>
            <p>
              The omp coding agent runs locally in RPC mode. Describe a task —
              it may use the approval-gated LHIC browser and desktop host
              tools.
            </p>
          </div>
        ) : (
          <div className="agent-messages">
            {earlier.map((message) => (
              <div
                className={`agent-message ${message.role}`}
                key={`earlier-${message.id}`}
              >
                <div className="agent-bubble">
                  <span>{message.text || "…"}</span>
                </div>
              </div>
            ))}
            {state.messages.map((message) => (
              <div
                className={`agent-message ${message.role}`}
                key={message.id}
              >
                <div className="agent-bubble">
                  <span>{message.text || "…"}</span>
                  {message.toolCalls.map((tool) => (
                    <div className="agent-tool-card" key={tool.id}>
                      <span className="tag">{tool.name}</span>
                      <span className={`status ${tool.state}`}>
                        {tool.state}
                      </span>
                      {tool.summary ? <small>{tool.summary}</small> : null}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
        <div className="agent-composer">
          <textarea
            value={draft}
            onChange={(input) => setDraft(input.target.value)}
            onKeyDown={(input) => {
              if (input.key === "Enter" && !input.shiftKey) {
                input.preventDefault();
                if (runtime?.isStreaming) void steer();
                else void send();
              }
            }}
            placeholder={
              runtime?.isStreaming
                ? "Steer or queue a follow-up…"
                : "Describe a task for the omp agent…"
            }
          />
          <div className="actions">
            {runtime?.isStreaming ? (
              <>
                <button className="button" onClick={() => void steer()}>
                  Steer
                </button>
                <button className="button" onClick={() => void followUp()}>
                  Follow-up
                </button>
                <button className="button caution" onClick={() => void abort()}>
                  Stop
                </button>
              </>
            ) : (
              <button
                className="button primary"
                onClick={() => void send()}
                disabled={!draft.trim()}
              >
                Send
              </button>
            )}
          </div>
        </div>
      </section>

      <aside className="panel agent-inspector" aria-label="Agent inspector">
        <div className="panel-title">
          <div>
            <span>INSPECTOR</span>
            <h2>Runtime</h2>
          </div>
        </div>
        {runtime ? (
          <>
            <div className="agent-inspector-status">
              <span className={`status ${runtime.running ? "running" : "revoked"}`}>
                {runtime.running ? "running" : "stopped"}
              </span>
              {runtime.error ? (
                <p className="muted">{runtime.error}</p>
              ) : null}
            </div>
            {runtime.model ? (
              <label>
                Model
                <select
                  value={modelValue}
                  onChange={(input) => void changeModel(input.target.value)}
                >
                  {models.map((model) => (
                    <option
                      key={`${model.provider}/${model.id}`}
                      value={`${model.provider}/${model.id}`}
                    >
                      {model.provider}/{model.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="agent-connect">
                <span className="eyebrow">CONNECT A PROVIDER</span>
                <p className="muted">
                  The agent engine is running locally. Choose a provider to
                  start an agent session.
                </p>
                {loginProviders.map((provider) => (
                  <button
                    className="quick-action"
                    key={provider.id}
                    onClick={() => void login(provider.id)}
                  >
                    Sign in with {provider.id} <i aria-hidden="true">→</i>
                  </button>
                ))}
              </div>
            )}
            <button className="button" onClick={() => void exportHtml()}>
              Export session HTML
            </button>
            <label>
              Session name
              <div className="agent-rename">
                <input
                  value={sessionName}
                  onChange={(input) => setSessionName(input.target.value)}
                  onKeyDown={(input) => {
                    if (input.key === "Enter") void renameSession();
                  }}
                  placeholder="Session name"
                />
                <button className="button" onClick={() => void renameSession()}>
                  Rename
                </button>
              </div>
            </label>
            {runtime.thinkingLevel ? (
              <label>
                Thinking level
                <select
                  value={runtime.thinkingLevel}
                  onChange={(input) =>
                    void setThinkingLevel(input.target.value)
                  }
                >
                  <option value="off">Off</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">X-High</option>
                  <option value="max">Max</option>
                </select>
              </label>
            ) : null}
            {runtime.fastModeEnabled !== undefined ? (
              <label className="check">
                <input
                  type="checkbox"
                  checked={runtime.fastModeEnabled}
                  onChange={(input) => void setFastMode(input.target.checked)}
                />
                Fast mode
                {runtime.fastModeActive !== undefined ? (
                  <span
                    className={`status ${
                      runtime.fastModeActive ? "running" : "revoked"
                    }`}
                  >
                    {runtime.fastModeActive ? "active" : "inactive"}
                  </span>
                ) : null}
              </label>
            ) : null}
            {runtime.interruptMode ? (
              <label>
                Interrupt mode
                <select
                  value={runtime.interruptMode}
                  onChange={(input) =>
                    void setInterruptMode(input.target.value)
                  }
                >
                  <option value="immediate">Immediate</option>
                  <option value="wait">Wait</option>
                </select>
              </label>
            ) : null}
            {runtime.contextUsage ? (
              <div className="agent-context">
                <span className="eyebrow">CONTEXT USAGE</span>
                <div className="agent-context-bar">
                  <i
                    style={{
                      width: `${Math.min(
                        100,
                        Math.max(0, runtime.contextUsage.percent * 100),
                      )}%`,
                    }}
                  />
                </div>
                <small>
                  {runtime.contextUsage.tokens.toLocaleString()} /{" "}
                  {runtime.contextUsage.contextWindow.toLocaleString()} tokens
                  ({Math.round(runtime.contextUsage.percent * 100)}%)
                </small>
              </div>
            ) : null}
            {state.commands?.length ? (
              <div className="agent-commands">
                <span className="eyebrow">COMMANDS</span>
                <div className="agent-command-chips">
                  {state.commands.map((command) => (
                    <button
                      className="tag agent-command-chip"
                      key={command.name}
                      title={command.description}
                      onClick={() => void insertCommand(command.name)}
                    >
                      /{command.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <AgentTodos phases={runtime.todoPhases} setNotice={setNotice} />
          </>
        ) : (
          <p className="muted">Starting the omp agent engine…</p>
        )}
      </aside>

      {state.uiRequest &&
      state.uiRequest.method !== "notify" &&
      state.uiRequest.id !== dismissedUi ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-label="Agent request">
            <span className="eyebrow">AGENT REQUEST / {state.uiRequest.method}</span>
            <h2>{state.uiRequest.title ?? "The agent needs input"}</h2>
            {state.uiRequest.message ? (
              <p className="muted">{state.uiRequest.message}</p>
            ) : null}
            {state.uiRequest.method === "confirm" ? (
              <div className="actions">
                <button
                  className="button primary"
                  onClick={() => void respondUi({ confirmed: true })}
                >
                  Approve
                </button>
                <button
                  className="button"
                  onClick={() => void respondUi({ confirmed: false })}
                >
                  Reject
                </button>
              </div>
            ) : (
              <div className="form-grid">
                <label>
                  {state.uiRequest.placeholder ?? "Response"}
                  <input
                    value={uiValue}
                    onChange={(input) => setUiValue(input.target.value)}
                    autoFocus
                  />
                </label>
                <div className="actions">
                  <button
                    className="button primary"
                    onClick={() => void respondUi({ value: uiValue })}
                  >
                    OK
                  </button>
                  <button
                    className="button"
                    onClick={() => void respondUi({ cancelled: true })}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : null}

      {state.hostToolCall &&
      state.hostToolCall.proposal &&
      state.hostToolCall.id !== dismissedHostTool ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-label="Host tool approval">
            <span className="eyebrow">HOST TOOL / {state.hostToolCall.toolName}</span>
            <h2>Approve local {state.hostToolCall.toolName} execution</h2>
            <p className="muted">
              The agent wants to run a plan through the LHIC local executor.
              Every step requires a separate approval and verifier evidence.
            </p>
            <div className="table proposal-table">
              {state.hostToolCall.proposal.steps.map((step) => (
                <div className="table-row" key={step.id}>
                  <strong>{step.intent}</strong>
                  <span className="tag">{step.action}</span>
                  <span className={`status ${step.riskLevel}`}>
                    {step.riskLevel}
                  </span>
                  <span>{step.verifier}</span>
                </div>
              ))}
            </div>
            <label>
              Approved by
              <input
                value={approvedBy}
                onChange={(input) => setApprovedBy(input.target.value)}
                placeholder="Your name"
              />
            </label>
            <div className="actions">
              <button
                className="button primary"
                onClick={() => void approveHostTool()}
              >
                Approve
              </button>
              <button className="button" onClick={() => void rejectHostTool()}>
                Reject
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentTodos({
  phases,
  setNotice,
}: {
  phases: OmpTodoPhase[];
  setNotice: (value: string) => void;
}): JSX.Element | null {
  const toggle = (phaseId: string, taskId: string, done: boolean) => {
    const next = phases.map((phase) =>
      phase.id === phaseId
        ? {
            ...phase,
            tasks: phase.tasks.map((task) =>
              task.id === taskId
                ? { ...task, status: done ? ("completed" as const) : ("pending" as const) }
                : task,
            ),
          }
        : phase,
    );
    void window.lhic.omp.setTodos(next).catch((error: unknown) => {
      setNotice(message(error));
    });
  };
  if (phases.length === 0) return null;
  return (
    <div className="agent-todos">
      <span className="eyebrow">TODOS</span>
      {phases.map((phase) => (
        <div key={phase.id}>
          <b>{phase.name}</b>
          {phase.tasks.map((task) => (
            <label className="check" key={task.id}>
              <input
                type="checkbox"
                checked={task.status === "completed"}
                onChange={(input) =>
                  toggle(phase.id, task.id, input.target.checked)
                }
              />
              {task.content}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

function scrollToBottom(): void {
  requestAnimationFrame(() => {
    const element = document.querySelector(".agent-chat");
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  });
}

function dedupeMessages(messages: OmpMessageView[]): OmpMessageView[] {
  const seen = new Set<string>();
  const result: OmpMessageView[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    result.push(message);
  }
  return result;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
