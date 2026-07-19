import { useEffect, useMemo, useState, type JSX } from "react";

import type {
  CommandEvent,
  DashboardSnapshot,
  GameProfile,
  GameTrainingEnvironment,
  GameTrainingRequest,
  JudgeDemoAsset,
  McpClientKind,
  McpConfigPreview,
  PolicyPackage,
  PolicyPackageRequest,
  SharedPolicyPackage,
  TaskApproval,
  TaskSourceConfig,
  TrainingJob,
  PublicWebTrainingRequest,
} from "../shared/contracts.js";
import {
  createDashboardOverview,
  type DashboardDestination,
} from "./dashboard-model.js";

type Section =
  | "dashboard"
  | "skills"
  | "tasks"
  | "mcp"
  | "game"
  | "security"
  | "judge"
  | "admin";

const sections: Array<{ id: Section; label: string; mark: string }> = [
  { id: "dashboard", label: "Overview", mark: "01" },
  { id: "skills", label: "Skill Depot", mark: "02" },
  { id: "tasks", label: "Task Console", mark: "03" },
  { id: "mcp", label: "MCP Link", mark: "04" },
  { id: "game", label: "Game Lab", mark: "05" },
  { id: "security", label: "Security", mark: "06" },
  { id: "judge", label: "Judge Center", mark: "07" },
  { id: "admin", label: "Admin", mark: "08" },
];

export function App(): JSX.Element {
  const [section, setSection] = useState<Section>("dashboard");
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [notice, setNotice] = useState(
    "Initializing the local control surface…",
  );

  const refresh = async () => {
    try {
      setSnapshot(await window.lhic.dashboard());
      setNotice("Runtime state verified locally.");
    } catch (error) {
      setNotice(message(error));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(
    () =>
      window.lhic.events.onProgress((event) => {
        setNotice(
          event.channel === "training"
            ? `Local job ${event.job.id} is ${event.job.status}.`
            : `Task ${event.task.commandId} is ${event.task.status}.`,
        );
        void window.lhic
          .dashboard()
          .then(setSnapshot)
          .catch((error: unknown) => setNotice(message(error)));
      }),
    [],
  );

  return (
    <main className="shell">
      <aside className="rail" aria-label="Control center navigation">
        <div className="brand">
          <span className="brand-mark">LH</span>
          <div>
            <strong>LHIC</strong>
            <small>CONTROL CENTER</small>
          </div>
        </div>
        <div className="rail-rule" />
        <nav>
          {sections.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
            >
              <span>{item.mark}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <span className="lamp" />
          LOCAL FIRST
          <br />
          <small>FAST PATH // MODEL-FREE</small>
        </div>
      </aside>
      <section className="content">
        <header className="topbar">
          <div>
            <span className="eyebrow">LOCAL HUMAN INTENT CONTROLLER</span>
            <h1>{sections.find((item) => item.id === section)?.label}</h1>
          </div>
          <div className="statusline">
            <span className="lamp" />
            GUARDED RUNTIME{" "}
            <button
              className="icon-button"
              onClick={() => void refresh()}
              title="Refresh runtime state"
            >
              ↻
            </button>
          </div>
        </header>
        <div className="notice" role="status">
          {notice}
        </div>
        {!snapshot ? (
          <div className="loading">Loading local runtime state…</div>
        ) : (
          <Panel
            section={section}
            snapshot={snapshot}
            setNotice={setNotice}
            refresh={refresh}
            navigate={setSection}
          />
        )}
      </section>
    </main>
  );
}

function Panel({
  section,
  snapshot,
  setNotice,
  refresh,
  navigate,
}: {
  section: Section;
  snapshot: DashboardSnapshot;
  setNotice: (value: string) => void;
  refresh: () => Promise<void>;
  navigate: (section: Section) => void;
}): JSX.Element {
  switch (section) {
    case "dashboard":
      return <Dashboard snapshot={snapshot} navigate={navigate} />;
    case "skills":
      return (
        <Skills snapshot={snapshot} setNotice={setNotice} refresh={refresh} />
      );
    case "tasks":
      return (
        <Tasks snapshot={snapshot} setNotice={setNotice} refresh={refresh} />
      );
    case "mcp":
      return <Mcp snapshot={snapshot} setNotice={setNotice} />;
    case "game":
      return <Game setNotice={setNotice} />;
    case "security":
      return <Security setNotice={setNotice} />;
    case "judge":
      return <Judge setNotice={setNotice} navigate={navigate} />;
    case "admin":
      return <Admin setNotice={setNotice} />;
  }
}

function Dashboard({
  snapshot,
  navigate,
}: {
  snapshot: DashboardSnapshot;
  navigate: (section: Section) => void;
}): JSX.Element {
  const overview = useMemo(() => createDashboardOverview(snapshot), [snapshot]);
  const go = (destination: DashboardDestination) => navigate(destination);

  return (
    <div className="dashboard-grid">
      <section
        className="panel wide command-center"
        aria-label="Command center"
      >
        <div className="command-primary">
          <span className="eyebrow">WORKSPACE / NEXT SAFE STEP</span>
          <span className={`status ${overview.priority.status}`}>
            {overview.priority.status.replaceAll("_", " ")}
          </span>
          <h2>{overview.priority.title}</h2>
          <p>{overview.priority.detail}</p>
          <div className="boundary compact command-boundary">
            <div>
              <b>FAST</b>
              <span>Verified local Skills</span>
            </div>
            <div>
              <b>SLOW</b>
              <span>Budgeted plan proposal</span>
            </div>
            <div>
              <b>TRACE</b>
              <span>Redacted verifier evidence</span>
            </div>
          </div>
          <button
            className="button primary"
            onClick={() => go(overview.priority.destination)}
          >
            {overview.priority.actionLabel}
          </button>
        </div>
        <aside className="command-side">
          <div className="command-side-heading">
            <div>
              <span>LIVE / PULSE</span>
              <h2>Control surface</h2>
            </div>
            <span className="runtime-pill">
              <span className="lamp" />
              LOCAL FIRST
            </span>
          </div>
          <dl className="pulse-grid">
            <div>
              <dt>FAST SKILLS</dt>
              <dd>{String(overview.fastPathSkillCount).padStart(2, "0")}</dd>
              <small>verified local routes</small>
            </div>
            <div>
              <dt>PLANNERS</dt>
              <dd>{String(overview.enabledSourceCount).padStart(2, "0")}</dd>
              <small>approval-gated sources</small>
            </div>
            <div>
              <dt>MCP CLIENTS</dt>
              <dd>{String(overview.detectedMcpCount).padStart(2, "0")}</dd>
              <small>detected locally</small>
            </div>
          </dl>
          <div className="quick-actions" aria-label="Quick actions">
            <button className="quick-action" onClick={() => go("skills")}>
              Train a Skill <i aria-hidden="true">→</i>
            </button>
            <button className="quick-action" onClick={() => go("mcp")}>
              Review MCP <i aria-hidden="true">→</i>
            </button>
          </div>
        </aside>
      </section>
      <section className="panel wide readiness-strip">
        <div className="readiness-copy">
          <span>READINESS / MAP</span>
          <h2>Local paths at a glance</h2>
          <p>Open any route to configure it; no change is applied from here.</p>
        </div>
        <ul className="readiness-list">
          {overview.readiness.map((item) => (
            <li key={item.id}>
              <button
                className="readiness-item"
                onClick={() => go(item.destination)}
              >
                <span className={`readiness-state ${item.state}`}>
                  {item.state}
                </span>
                <span>
                  <b>{item.label}</b>
                  <small>{item.detail}</small>
                </span>
                <i aria-hidden="true">→</i>
              </button>
            </li>
          ))}
        </ul>
      </section>
      {overview.attention.length ? (
        <section className="panel wide attention-panel">
          <PanelTitle
            code="ATTENTION/QUEUE"
            title="Needs a decision"
            action={
              <button className="button ghost" onClick={() => go("tasks")}>
                Open task console
              </button>
            }
          />
          <ul className="attention-list">
            {overview.attention.map((item) => (
              <li key={item.id}>
                <button
                  className="attention-item"
                  onClick={() => go(item.destination)}
                >
                  <span className={`status ${item.status}`}>
                    {item.status.replaceAll("_", " ")}
                  </span>
                  <span>
                    <b>{item.title}</b>
                    <small>{item.detail}</small>
                  </span>
                  <i aria-hidden="true">→</i>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="panel wide">
        <PanelTitle code="EVENT/LOG" title="Recent evidence" />
        {snapshot.recentEvents.length ? (
          <ul className="event-list">
            {snapshot.recentEvents.map((event) => (
              <EventRow key={event.commandId} event={event} />
            ))}
          </ul>
        ) : (
          <p className="muted">
            No actions have been admitted in this desktop session.
          </p>
        )}
      </section>
    </div>
  );
}

function Skills({
  snapshot,
  setNotice,
  refresh,
}: {
  snapshot: DashboardSnapshot;
  setNotice: (value: string) => void;
  refresh: () => Promise<void>;
}): JSX.Element {
  const [destination, setDestination] = useState("./lhic-approved-skills.zip");
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [trainingInput, setTrainingInput] = useState<PublicWebTrainingRequest>({
    scenarioId: "wikipedia-search",
    query: "browser automation",
  });
  const [trainingJob, setTrainingJob] = useState<TrainingJob>();
  useEffect(
    () =>
      window.lhic.events.onProgress((event) => {
        if (event.channel === "training" && event.job.kind === "public-web") {
          setTrainingJob(event.job);
        }
      }),
    [],
  );
  const visibleSkills = snapshot.skills.filter((skill) =>
    skill.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const login = async () => {
    try {
      setNotice(
        "Magic Link requested. Complete the email sign-in to refresh the local session.",
      );
      const event = await window.lhic.skills.login(email);
      setNotice(event.message);
      await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const sync = async () => {
    try {
      const event = await window.lhic.skills.sync();
      setNotice(event.message);
      await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const exportAll = async () => {
    try {
      const result = await window.lhic.skills.exportApproved(destination);
      setNotice(`Exported ${result.count} approved skills to ${result.path}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };
  const startTraining = async () => {
    try {
      const job = await window.lhic.skills.trainPublicWeb(trainingInput);
      setTrainingJob(job);
      setNotice(
        "Public-web Skill training started. It uses allowlisted browser actions and verifier evidence only.",
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const refreshTraining = async () => {
    if (!trainingJob) return;
    try {
      const job = await window.lhic.skills.trainingStatus(trainingJob.id);
      setTrainingJob(job);
      setNotice(`Public-web training is ${job.status}.`);
      if (job.status === "completed") await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const cancelTraining = async () => {
    if (!trainingJob) return;
    try {
      await window.lhic.skills.cancelTraining(trainingJob.id);
      await refreshTraining();
    } catch (error) {
      setNotice(message(error));
    }
  };
  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle code="REGISTRY/LOGIN" title="Shared library connection" />
        <p className="muted">
          {snapshot.sharedLibrary.configured
            ? `Registry mirror: ${snapshot.sharedLibrary.cachedSkillCount} approved records; ${snapshot.sharedLibrary.pendingSubmissionCount} local submissions pending review.`
            : "The bundled Appwrite registry is waiting for Magic Link sign-in."}
        </p>
        {snapshot.sharedLibrary.lastSuccessAt ? (
          <p className="verified">
            Last verified sync: {snapshot.sharedLibrary.lastSuccessAt}
          </p>
        ) : null}
        {snapshot.sharedLibrary.lastError ? (
          <p className="muted">
            Latest sync result: {snapshot.sharedLibrary.lastError}
          </p>
        ) : null}
        <div className="form-grid">
          <label>
            Magic Link email for the bundled registry
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        </div>
        <div className="actions">
          <button className="button primary" onClick={() => void login()}>
            Sign in with Magic Link
          </button>
        </div>
      </section>
      <section className="panel">
        <PanelTitle
          code="DEPOT/02"
          title="Skill lifecycle"
          action={
            <button className="button" onClick={() => void sync()}>
              Sync registry
            </button>
          }
        />
        <p className="muted">
          Only verified candidates may enter the pending queue. Admin approval
          is required before a shared skill becomes downloadable or Fast Path
          eligible.
        </p>
        <label>
          Search local and shared Skills
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by Skill name"
          />
        </label>
        <div className="table">
          {visibleSkills.map((skill) => (
            <div className="table-row" key={`${skill.source}-${skill.name}`}>
              <strong>{skill.name}</strong>
              <span className="tag">{skill.source}</span>
              <span className={`status ${skill.status}`}>{skill.status}</span>
              <span>{skill.fastPathEligible ? "FAST-READY" : "SLOW ONLY"}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <PanelTitle code="EXPORT/ZIP" title="Approved library export" />
        <div className="form-row">
          <label>
            Destination
            <input
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              aria-label="Export destination"
            />
          </label>
          <button className="button primary" onClick={() => void exportAll()}>
            Create verified ZIP
          </button>
        </div>
        <p className="muted">
          The archive contains only approved definitions plus a SHA-256
          manifest. Pending records, secrets, and raw game datasets are
          excluded.
        </p>
      </section>
      <section className="panel">
        <PanelTitle code="TRAIN/VERIFY" title="Public-web Skill training" />
        <p className="muted">
          Run a read-only, allowlisted public-web workflow to create a local
          candidate with verifier evidence. Candidates remain local until three
          independent verified runs and an offline holdout pass are recorded.
        </p>
        <div className="form-grid">
          <label>
            Scenario
            <select
              value={trainingInput.scenarioId}
              onChange={(event) =>
                setTrainingInput({
                  ...trainingInput,
                  scenarioId: event.target
                    .value as PublicWebTrainingRequest["scenarioId"],
                })
              }
            >
              <option value="wikipedia-search">Wikipedia public search</option>
              <option value="mdn-search">MDN documentation search</option>
              <option value="github-issue-filter">
                GitHub public issue filter
              </option>
              <option value="openstreetmap-place-search">
                OpenStreetMap place search
              </option>
              <option value="psycho-flow">
                Psycho Flow advanced psychological survey
              </option>
            </select>
          </label>
          <label>
            Public query
            <input
              value={trainingInput.query}
              onChange={(event) =>
                setTrainingInput({
                  ...trainingInput,
                  query: event.target.value,
                })
              }
              maxLength={256}
              autoComplete="off"
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={trainingInput.viewable === true}
              onChange={(event) => {
                setTrainingInput({
                  ...trainingInput,
                  viewable: event.target.checked,
                });
              }}
            />
            Show the training browser window
          </label>
          <p className="hint">
            Training records a candidate only. Fast Path promotion requires
            three independently verified executions and a separate offline
            holdout on an unseen UI fingerprint.
          </p>
        </div>
        <div className="actions">
          <button
            className="button caution"
            onClick={() => void startTraining()}
          >
            Start verified training
          </button>
          {trainingJob ? (
            <>
              <button className="button" onClick={() => void refreshTraining()}>
                Refresh status
              </button>
              {trainingJob.status === "running" ? (
                <button
                  className="button ghost"
                  onClick={() => void cancelTraining()}
                >
                  Cancel training
                </button>
              ) : null}
              <span className={`status ${trainingJob.status}`}>
                {trainingJob.status}
              </span>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Tasks({
  snapshot,
  setNotice,
  refresh,
}: {
  snapshot: DashboardSnapshot;
  setNotice: (value: string) => void;
  refresh: () => Promise<void>;
}): JSX.Element {
  const [goal, setGoal] = useState("");
  const [startUrl, setStartUrl] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [sourceConfig, setSourceConfig] = useState<TaskSourceConfig>();
  const [event, setEvent] = useState<CommandEvent>();
  const [approvalJson, setApprovalJson] = useState("");
  useEffect(
    () =>
      window.lhic.events.onProgress((update) => {
        if (update.channel === "task") setEvent(update.task);
      }),
    [],
  );
  const start = async () => {
    try {
      const result = await window.lhic.tasks.start({
        goal,
        ...(startUrl.trim() ? { startUrl: startUrl.trim() } : {}),
        ...(sourceId ? { sourceId } : {}),
      });
      setEvent(result);
      setNotice(result.message);
      await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const approve = async () => {
    if (!event) return;
    try {
      const approval = approvalJson.trim()
        ? (JSON.parse(approvalJson) as TaskApproval)
        : undefined;
      const result = await window.lhic.tasks.approve(event.commandId, approval);
      setEvent(result);
      setNotice(result.message);
      await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const execute = async () => {
    if (!event) return;
    try {
      const result = await window.lhic.tasks.execute(event.commandId);
      setEvent(result);
      setNotice(result.message);
      await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const saveSource = async () => {
    if (!sourceConfig) return;
    try {
      const configured = await window.lhic.tasks.configure(sourceConfig);
      setSourceConfig(configured);
      setNotice(`${configured.label} configuration saved locally.`);
      await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const autoConfigureSources = async () => {
    try {
      await window.lhic.tasks.autoConfigure();
      setNotice(
        "Detected local CLI planners were configured from their existing local sign-in state.",
      );
      await refresh();
    } catch (error) {
      setNotice(message(error));
    }
  };
  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle code="TASK/03" title="Admit a task" />
        <label>
          Intent
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Describe the task. LHIC tries a verified Fast Path skill first, then requests a guarded Slow Path plan when needed."
          />
        </label>
        <div className="form-row">
          <label>
            Browser start URL (browser tasks only)
            <input
              type="url"
              value={startUrl}
              onChange={(event) => setStartUrl(event.target.value)}
              placeholder="https://example.com/search"
            />
          </label>
          <label>
            Slow Path source
            <select
              value={sourceId}
              onChange={(event) => {
                const nextId = event.target.value;
                setSourceId(nextId);
                setSourceConfig(
                  snapshot.sources.find((source) => source.id === nextId),
                );
              }}
            >
              <option value="">
                Automatic — Fast Path, then configured Slow Path
              </option>
              {snapshot.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.label}
                  {source.enabled ? "" : " (configure credential)"}
                </option>
              ))}
            </select>
          </label>
          <button className="button primary" onClick={() => void start()}>
            Start guarded task
          </button>
          <button
            className="button"
            onClick={() => void autoConfigureSources()}
          >
            Detect local planners
          </button>
        </div>
      </section>
      {sourceConfig && (
        <section className="panel">
          <PanelTitle code="SOURCE/CONFIG" title={sourceConfig.label} />
          <p className="muted">
            A configured source may produce a browser or desktop plan proposal
            only. It cannot receive a browser, MCP, or OS control handle.
          </p>
          <div className="form-grid">
            <label>
              Model
              <input
                value={sourceConfig.model ?? ""}
                onChange={(event) =>
                  setSourceConfig({
                    ...sourceConfig,
                    model: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Keychain credential id
              <input
                value={sourceConfig.credentialId ?? sourceConfig.id}
                onChange={(event) =>
                  setSourceConfig({
                    ...sourceConfig,
                    credentialId: event.target.value,
                  })
                }
              />
            </label>
            {sourceConfig.kind === "openai-compatible" && (
              <>
                <label>
                  HTTPS endpoint
                  <input
                    value={sourceConfig.endpoint ?? ""}
                    onChange={(event) =>
                      setSourceConfig({
                        ...sourceConfig,
                        endpoint: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Protocol
                  <select
                    value={sourceConfig.protocol ?? "responses"}
                    onChange={(event) =>
                      setSourceConfig({
                        ...sourceConfig,
                        protocol: event.target.value as
                          "responses" | "chat-completions",
                      })
                    }
                  >
                    <option value="responses">Responses</option>
                    <option value="chat-completions">Chat Completions</option>
                  </select>
                </label>
              </>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={sourceConfig.enabled}
                onChange={(event) =>
                  setSourceConfig({
                    ...sourceConfig,
                    enabled: event.target.checked,
                  })
                }
              />
              Enable this bounded Slow Path source
            </label>
          </div>
          <div className="actions">
            <button className="button" onClick={() => void saveSource()}>
              Save source configuration
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <PanelTitle code="POLICY/GATE" title="Human approval" />
        {event ? (
          <>
            <EventRow event={event} />
            {event.proposal && (
              <div className="table proposal-table">
                {event.proposal.steps.map((step) => (
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
            )}
            {event.status === "awaiting_approval" && (
              <label>
                Signed approval JSON (required for production actions)
                <textarea
                  value={approvalJson}
                  onChange={(input) => setApprovalJson(input.target.value)}
                  placeholder="Optional in development. Paste the externally signed approval for production."
                />
              </label>
            )}
            <div className="actions">
              {event.status === "proposed" && (
                <button
                  className="button primary"
                  onClick={() => void execute()}
                >
                  Start browser execution
                </button>
              )}
              {event.status === "awaiting_approval" && (
                <button
                  className="button caution"
                  onClick={() => void approve()}
                >
                  Approve pending step
                </button>
              )}
              <button
                className="button ghost"
                onClick={() => void window.lhic.tasks.cancel(event.commandId)}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <p className="muted">
            High-risk, unknown, activation, keyboard, download and OS actions
            cannot cross this gate without approval.
          </p>
        )}
      </section>
    </div>
  );
}

function Mcp({
  snapshot,
  setNotice,
}: {
  snapshot: DashboardSnapshot;
  setNotice: (value: string) => void;
}): JSX.Element {
  const [client, setClient] = useState<McpClientKind>("codex");
  const [preview, setPreview] = useState<McpConfigPreview>();
  const workspace = snapshot.runtime.workspaceRoot;
  const inspect = async () => {
    try {
      const value = await window.lhic.mcp.preview(client, workspace);
      setPreview(value);
      setNotice(
        value.changed
          ? "Preview generated. Review the exact change before applying."
          : "No configuration change is needed.",
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const apply = async () => {
    try {
      if (!preview) {
        setNotice(
          "Generate and review a configuration preview before applying it.",
        );
        return;
      }
      const value = await window.lhic.mcp.apply(
        client,
        workspace,
        preview.confirmationToken,
      );
      setPreview(value);
      const probe = await window.lhic.mcp.probe(client, workspace);
      setNotice(
        `${value.backupPath ? `Configuration applied. Backup: ${value.backupPath}` : "MCP command completed."} ${probe.message}`,
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle code="MCP/04" title="Detect → preview → confirm" />
        <div className="client-grid">
          {snapshot.mcp.map((adapter) => (
            <button
              key={adapter.id}
              className={
                client === adapter.id ? "client-card selected" : "client-card"
              }
              onClick={() => setClient(adapter.id)}
            >
              <b>{adapter.label}</b>
              <span className={adapter.detected ? "verified" : "muted"}>
                {adapter.detected ? "DETECTED" : "NOT DETECTED"}
              </span>
              <small>{adapter.format.toUpperCase()}</small>
            </button>
          ))}
        </div>
        <div className="actions">
          <button className="button" onClick={() => void inspect()}>
            Preview configuration
          </button>
          {preview?.changed && (
            <button className="button primary" onClick={() => void apply()}>
              Confirm and apply
            </button>
          )}
          {preview && (
            <button
              className="button"
              onClick={() =>
                void window.lhic.mcp
                  .probe(client, workspace)
                  .then((result) => setNotice(result.message))
                  .catch((error: unknown) => setNotice(message(error)))
              }
            >
              Run health probe
            </button>
          )}
        </div>
      </section>
      {preview && (
        <section className="panel">
          <PanelTitle code="DIFF/REVIEW" title={preview.adapter.label} />
          <div className="diff">
            <pre>
              <b>BEFORE</b>
              {"\n"}
              {preview.before || "(client-managed command)"}
            </pre>
            <pre>
              <b>AFTER</b>
              {"\n"}
              {preview.after.replaceAll("\u0000", " ")}
            </pre>
          </div>
          <p className="muted">
            Health check: <code>{preview.healthCheck}</code>
          </p>
        </section>
      )}
    </div>
  );
}

function Game({
  setNotice,
}: {
  setNotice: (value: string) => void;
}): JSX.Element {
  const [profile, setProfile] = useState<GameProfile>({
    id: "custom-local",
    title: "Custom local game",
    surface: "desktop",
    target: "",
    allowedKeys: ["KeyW", "KeyA", "KeyS", "KeyD", "Space"],
    allowPrimaryClick: true,
    attestedSinglePlayer: false,
    captureRegion: { x: 0, y: 0, width: 1280, height: 720 },
  });
  const [training, setTraining] = useState<GameTrainingRequest>({
    core: "3d",
    action: "record",
    profileId: "custom",
    windowTitle: "",
    captureRegion: { x: 0, y: 0, width: 1280, height: 720 },
    durationMs: 30_000,
    approvedBy: "local-operator",
  });
  const [job, setJob] = useState<TrainingJob>();
  const [environment, setEnvironment] = useState<GameTrainingEnvironment>();
  const [packageInput, setPackageInput] = useState<PolicyPackageRequest>({
    artifactPath: ".lhic/game-training/2d/skills/artifact.json",
    destinationDirectory: ".lhic/game-training/policy-packages/review-package",
    evaluationReportPath: ".lhic/game-training/2d/reports/evaluation.json",
  });
  const [policyPackage, setPolicyPackage] = useState<PolicyPackage>();
  const [policySubmission, setPolicySubmission] = useState({
    bundleUrl: "",
    version: "v1",
  });
  useEffect(
    () =>
      window.lhic.events.onProgress((event) => {
        if (
          event.channel === "training" &&
          event.job.kind.startsWith("game-")
        ) {
          setJob(event.job);
        }
      }),
    [],
  );
  const inspectRuntime = async () => {
    try {
      const result = await window.lhic.game.inspectRuntime();
      setEnvironment(result);
      setNotice(
        result.ready
          ? "Local Game Lab runtime is ready."
          : (result.detail ?? "Local Game Lab runtime is not ready."),
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const prepareRuntime = async () => {
    try {
      setNotice("Preparing the local Python runtime for Game Lab…");
      const result = await window.lhic.game.prepareRuntime();
      setEnvironment(result);
      setNotice(
        result.ready
          ? "Local Game Lab runtime is ready."
          : (result.detail ?? "Game Lab runtime setup did not complete."),
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const validate = async () => {
    try {
      const result = await window.lhic.game.validate(profile);
      setProfile(result);
      setNotice(
        "Custom Game profile passed local policy validation. Recording still requires an active window, a short lease, and continuous focus checks.",
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const run = async () => {
    try {
      const customProfile =
        training.profileId === "custom"
          ? await window.lhic.game.validate(profile)
          : undefined;
      const nextJob = await window.lhic.game.run({
        ...training,
        ...(customProfile
          ? {
              customProfile,
              windowTitle: customProfile.target,
              captureRegion: customProfile.captureRegion,
            }
          : {}),
      });
      setJob(nextJob);
      setNotice(
        `Human-play recording ${nextJob.id} is running locally. Raw frames and input samples stay on this device.`,
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const checkJob = async () => {
    if (!job) return;
    try {
      const current = await window.lhic.game.status(job.id);
      setJob(current);
      setNotice(`Game training job is ${current.status}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };
  const cancelJob = async () => {
    if (!job) return;
    try {
      await window.lhic.game.cancel(job.id);
      await checkJob();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const preparePolicyPackage = async () => {
    try {
      const created = await window.lhic.game.packagePolicy(packageInput);
      setPolicyPackage(created);
      setNotice(
        "Policy-only review package created locally. It contains the artifact, weights, action mapping, and optional evaluation report; raw recordings remain local.",
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const submitPolicyPackage = async () => {
    if (!policyPackage) return;
    try {
      const submitted = await window.lhic.game.submitPolicy({
        package: policyPackage,
        bundleUrl: policySubmission.bundleUrl,
        version: policySubmission.version,
      });
      setPolicyPackage({ ...policyPackage, status: submitted.status });
      setNotice(
        `Policy package ${submitted.packageId.slice(0, 12)} is ${submitted.status}. The shared library received hashes and the HTTPS bundle URL only.`,
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle code="RUNTIME/LOCAL" title="Game Lab runtime" />
        <p className="muted">
          Recording uses a local Python environment. Preparing it installs only
          the pinned local training requirements; it does not grant game or
          model access to the desktop.
        </p>
        <div className="actions">
          <button className="button" onClick={() => void inspectRuntime()}>
            Check runtime
          </button>
          <button
            className="button primary"
            onClick={() => void prepareRuntime()}
          >
            Prepare local runtime
          </button>
          {environment ? (
            <span
              className={`status ${environment.ready ? "completed" : "failed"}`}
            >
              {environment.ready ? "ready" : "not ready"}
            </span>
          ) : null}
        </div>
      </section>
      <section className="panel">
        <PanelTitle code="GAME/05" title="Experimental Custom Game" />
        <p className="muted">
          Record an authorised single-player session from an exact desktop
          window. The recorder only observes local frames and allowlisted input;
          it never sends raw gameplay data to a model or shared library.
        </p>
        <div className="form-grid">
          <label>
            Profile id
            <input
              value={profile.id}
              onChange={(event) =>
                setProfile({ ...profile, id: event.target.value })
              }
            />
          </label>
          <label>
            Exact window title
            <input
              value={profile.target}
              onChange={(event) =>
                setProfile({ ...profile, target: event.target.value })
              }
            />
          </label>
          <label>
            Capture region (x, y, width, height)
            <input
              value={formatRegion(profile.captureRegion)}
              onChange={(event) => {
                const captureRegion = parseRegion(event.target.value);
                if (captureRegion) setProfile({ ...profile, captureRegion });
              }}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={profile.attestedSinglePlayer}
              onChange={(event) =>
                setProfile({
                  ...profile,
                  attestedSinglePlayer: event.target.checked,
                })
              }
            />
            I confirm this is authorized, single-player, and non-transactional.
          </label>
        </div>
        <div className="actions">
          <button className="button" onClick={() => void validate()}>
            Validate profile
          </button>
        </div>
      </section>
      <section className="panel">
        <PanelTitle code="TRAINING/LOCAL" title="Local Game workflow" />
        <p className="muted">
          Human-play recording uses a target-bound lease and focus check before
          every frame. Setup, policy fitting, evaluation, and browser playback
          run through the packaged local runtime; raw custom-game recordings
          remain local.
        </p>
        <div className="form-grid">
          <label>
            Core
            <select
              value={training.core}
              onChange={(event) => {
                const core = event.target.value as GameTrainingRequest["core"];
                setTraining({
                  ...training,
                  core,
                  profileId: core === "2d" ? "star-trooper" : "custom",
                });
              }}
            >
              <option value="2d">2D</option>
              <option value="3d">3D</option>
            </select>
          </label>
          <label>
            Approved target
            <select
              value={training.profileId}
              onChange={(event) =>
                setTraining({
                  ...training,
                  profileId: event.target
                    .value as GameTrainingRequest["profileId"],
                  ...(event.target.value === "custom"
                    ? { action: "record" }
                    : {}),
                })
              }
            >
              <option value="custom">Experimental custom profile</option>
              {training.core === "2d" ? (
                <option value="star-trooper">Star Trooper</option>
              ) : (
                <>
                  <option value="epic-shooter-3d">Epic Shooter 3D</option>
                  <option value="nemesis">Nemesis</option>
                </>
              )}
            </select>
          </label>
          {training.profileId !== "custom" ? (
            <label>
              Local action
              <select
                value={training.action}
                onChange={(event) =>
                  setTraining({
                    ...training,
                    action: event.target.value as GameTrainingRequest["action"],
                  })
                }
              >
                <option value="setup">Set up approved target</option>
                <option value="record">Record human play</option>
                <option value="fit">Fit local policy</option>
                <option value="evaluate">Evaluate policy</option>
                <option value="play">Start browser playback</option>
              </select>
            </label>
          ) : null}
          {training.profileId !== "custom" ? (
            <label>
              Approved window title
              <input
                value={training.windowTitle}
                onChange={(event) =>
                  setTraining({ ...training, windowTitle: event.target.value })
                }
                placeholder="Exact active window title"
              />
            </label>
          ) : null}
          {training.profileId !== "custom" ? (
            <label>
              Capture region (x, y, width, height)
              <input
                value={formatRegion(training.captureRegion)}
                onChange={(event) => {
                  const captureRegion = parseRegion(event.target.value);
                  if (captureRegion)
                    setTraining({ ...training, captureRegion });
                }}
              />
            </label>
          ) : null}
          <label>
            Lease approver
            <input
              value={training.approvedBy}
              onChange={(event) =>
                setTraining({ ...training, approvedBy: event.target.value })
              }
            />
          </label>
          <label>
            Duration (seconds)
            <input
              type="number"
              min="1"
              max="300"
              value={Math.round((training.durationMs ?? 30_000) / 1_000)}
              onChange={(event) =>
                setTraining({
                  ...training,
                  durationMs: Math.round(Number(event.target.value) * 1_000),
                })
              }
            />
          </label>
          {gameResourceLabel(training.action) ? (
            <label>
              {gameResourceLabel(training.action)}
              <input
                value={training.resourcePath ?? ""}
                onChange={(event) =>
                  setTraining({ ...training, resourcePath: event.target.value })
                }
                placeholder="Path inside the active workspace"
              />
            </label>
          ) : null}
        </div>
        {training.profileId === "custom" ? (
          <p className="muted">
            The custom profile above supplies the action allowlist and capture
            region for this recording.
          </p>
        ) : null}
        <div className="actions">
          <button className="button caution" onClick={() => void run()}>
            {training.action === "record"
              ? "Start human-play recording"
              : "Start local workflow"}
          </button>
          {job ? (
            <>
              <button className="button" onClick={() => void checkJob()}>
                Refresh job
              </button>
              {job.status === "running" ? (
                <button
                  className="button ghost"
                  onClick={() => void cancelJob()}
                >
                  Cancel job
                </button>
              ) : null}
              <span className={`status ${job.status}`}>{job.status}</span>
            </>
          ) : null}
        </div>
      </section>
      <section className="panel">
        <PanelTitle code="PACKAGE/REVIEW" title="Policy-only review package" />
        <p className="muted">
          Prepare the exact policy files for review. The package rejects
          dataset, frame, mouse, keyboard, and trace references. It remains
          local until an administrator reviews and approves a separately
          submitted package.
        </p>
        <div className="form-grid">
          <label>
            Verified policy artifact
            <input
              value={packageInput.artifactPath}
              onChange={(event) =>
                setPackageInput({
                  ...packageInput,
                  artifactPath: event.target.value,
                })
              }
            />
          </label>
          <label>
            Evaluation report (optional)
            <input
              value={packageInput.evaluationReportPath ?? ""}
              onChange={(event) =>
                setPackageInput({
                  ...(event.target.value
                    ? {
                        ...packageInput,
                        evaluationReportPath: event.target.value,
                      }
                    : {
                        artifactPath: packageInput.artifactPath,
                        destinationDirectory: packageInput.destinationDirectory,
                      }),
                })
              }
            />
          </label>
          <label>
            Package directory
            <input
              value={packageInput.destinationDirectory}
              onChange={(event) =>
                setPackageInput({
                  ...packageInput,
                  destinationDirectory: event.target.value,
                })
              }
            />
          </label>
        </div>
        <div className="actions">
          <button
            className="button"
            onClick={() => void preparePolicyPackage()}
          >
            Create local review package
          </button>
          {policyPackage ? (
            <span className="verified">
              {policyPackage.packageId.slice(0, 12)} ·{" "}
              {policyPackage.core.toUpperCase()} · {policyPackage.status}
            </span>
          ) : null}
        </div>
        {policyPackage ? (
          <>
            <p className="muted">
              Bundle: {policyPackage.bundlePath}
              <br />
              Bundle SHA-256: {policyPackage.bundleSha256}
              <br />
              Weights SHA-256: {policyPackage.weightsSha256}
            </p>
            {policyPackage.status === "local" ? (
              <div className="form-grid">
                <label>
                  HTTPS bundle URL
                  <input
                    type="url"
                    value={policySubmission.bundleUrl}
                    onChange={(event) =>
                      setPolicySubmission({
                        ...policySubmission,
                        bundleUrl: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  Package version
                  <input
                    value={policySubmission.version}
                    onChange={(event) =>
                      setPolicySubmission({
                        ...policySubmission,
                        version: event.target.value,
                      })
                    }
                  />
                </label>
                <div className="actions align-end">
                  <button
                    className="button primary"
                    onClick={() => void submitPolicyPackage()}
                  >
                    Submit metadata for review
                  </button>
                </div>
              </div>
            ) : null}
            <p className="muted">
              Upload the generated ZIP to the controlled HTTPS location first.
              Submission does not upload local files; it re-verifies the ZIP,
              then sends only integrity metadata and its URL to the review
              queue.
            </p>
          </>
        ) : null}
      </section>
      <section className="panel">
        <PanelTitle code="CONTROL/LEASE" title="Hard stops" />
        <div className="boundary compact">
          <div>
            <b>01</b>
            <span>
              Lease expires
              <br />
              within five minutes
            </span>
          </div>
          <div>
            <b>02</b>
            <span>
              Focus loss releases
              <br />
              all held keys
            </span>
          </div>
          <div>
            <b>03</b>
            <span>
              Emergency stop ends
              <br />
              the input session
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function formatRegion(region: GameProfile["captureRegion"]): string {
  if (!region) return "";
  return `${region.x}, ${region.y}, ${region.width}, ${region.height}`;
}

function parseRegion(value: string): GameProfile["captureRegion"] | undefined {
  const parts = value.split(",").map((part) => Number(part.trim()));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isSafeInteger(part)) ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined ||
    parts[3] === undefined ||
    parts[0] < 0 ||
    parts[1] < 0 ||
    parts[2] < 1 ||
    parts[3] < 1
  ) {
    return undefined;
  }
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
}

function gameResourceLabel(
  action: GameTrainingRequest["action"],
): string | undefined {
  switch (action) {
    case "setup":
      return "Local game source directory";
    case "fit":
      return "Dataset manifest path";
    case "evaluate":
    case "play":
      return "Policy artifact path";
    case "lease":
    case "record":
      return undefined;
  }
}

function Security({
  setNotice,
}: {
  setNotice: (value: string) => void;
}): JSX.Element {
  const [id, setId] = useState("openai-responses");
  const [secret, setSecret] = useState("");
  const [present, setPresent] = useState<boolean>();
  const [configuration, setConfiguration] =
    useState<Awaited<ReturnType<typeof window.lhic.security.configuration>>>();
  useEffect(() => {
    void window.lhic.security
      .configuration()
      .then(setConfiguration)
      .catch((error: unknown) => setNotice(message(error)));
  }, [setNotice]);
  const save = async () => {
    try {
      await window.lhic.credentials.set(id, secret);
      setSecret("");
      setNotice(
        "Credential stored in the operating-system keychain. It was not added to application state or traces.",
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const check = async () => {
    try {
      setPresent(await window.lhic.credentials.has(id));
    } catch (error) {
      setNotice(message(error));
    }
  };
  const configureSlowPathProfile = async (
    slowPathProfile: "fast_only" | "balanced" | "deliberative",
  ) => {
    try {
      const updated = await window.lhic.security.configure({ slowPathProfile });
      setConfiguration(updated);
      setNotice(
        `Slow Path safety profile changed to ${updated.slowPathProfile}. Existing approval, verifier, and redaction controls remain enforced.`,
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle code="KEYCHAIN/06" title="Local provider credentials" />
        <div className="form-row">
          <label>
            Credential id
            <input value={id} onChange={(event) => setId(event.target.value)} />
          </label>
          <label>
            Secret
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="off"
            />
          </label>
          <button className="button primary" onClick={() => void save()}>
            Store locally
          </button>
          <button className="button" onClick={() => void check()}>
            Check
          </button>
        </div>
        {present !== undefined && (
          <p className="muted">
            Keychain entry: {present ? "present" : "not configured"}
          </p>
        )}
      </section>
      <section className="panel">
        <PanelTitle code="POLICY/06" title="Execution safety profile" />
        <p className="muted">
          This setting controls only the maximum local Slow Path budget for
          future tasks. It cannot disable per-action approval, verifier
          evidence, redaction, or the model-free Fast Path boundary.
        </p>
        <div className="form-row">
          <label>
            Slow Path budget
            <select
              value={configuration?.slowPathProfile ?? "balanced"}
              onChange={(event) =>
                void configureSlowPathProfile(
                  event.target.value as
                    "fast_only" | "balanced" | "deliberative",
                )
              }
            >
              <option value="fast_only">
                Fast Path only — no provider calls
              </option>
              <option value="balanced">Balanced — one provider proposal</option>
              <option value="deliberative">
                Deliberative — up to three provider proposals
              </option>
            </select>
          </label>
          {configuration?.updatedAt ? (
            <span className="muted">
              Saved locally: {configuration.updatedAt}
            </span>
          ) : configuration ? (
            <span className="muted">
              Default local policy is active; changing the profile saves it for
              this workspace.
            </span>
          ) : null}
        </div>
      </section>
      <section className="panel">
        <PanelTitle code="GUARDRAILS" title="Non-negotiable safety" />
        <ul className="checklist">
          <li>Fast Path never calls an LLM or MCP server.</li>
          <li>
            Custom model endpoints require HTTPS and reject private networks.
          </li>
          <li>
            Secrets, cookies, keys and PII are redacted before trace or model
            boundaries.
          </li>
          <li>
            External submission, OS automation and unknown risk require human
            approval.
          </li>
        </ul>
      </section>
    </div>
  );
}

function Judge({
  setNotice,
  navigate,
}: {
  setNotice: (value: string) => void;
  navigate: (section: Section) => void;
}): JSX.Element {
  const [session, setSession] = useState<string>();
  const [judgeToken, setJudgeToken] = useState("");
  const [assets, setAssets] = useState<
    Awaited<ReturnType<typeof window.lhic.judge.catalog>>
  >([]);
  const [policyPackages, setPolicyPackages] = useState<SharedPolicyPackage[]>(
    [],
  );
  const beginGithubLogin = async () => {
    try {
      const state = await window.lhic.judge.beginGithubLogin();
      setNotice(state.message);
    } catch (error) {
      setNotice(message(error));
    }
  };
  const checkAccess = async () => {
    try {
      const state = await window.lhic.judge.pollGithubLogin();
      if (state.status !== "complete") {
        setNotice(state.message);
        return;
      }
      const judge = await window.lhic.judge.session();
      const [catalog, packages] = await Promise.all([
        window.lhic.judge.catalog(),
        window.lhic.judge.policyPackages(),
      ]);
      setSession(judge.subject);
      setAssets(catalog);
      setPolicyPackages(packages);
      setNotice(`Judge Center unlocked through ${judge.subject}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };
  const refreshCatalog = async () => {
    try {
      const judge = await window.lhic.judge.session();
      const [catalog, packages] = await Promise.all([
        window.lhic.judge.catalog(),
        window.lhic.judge.policyPackages(),
      ]);
      setSession(judge.subject);
      setAssets(catalog);
      setPolicyPackages(packages);
      setNotice("Judge evidence catalog refreshed from the control plane.");
    } catch (error) {
      setNotice(message(error));
    }
  };
  const authorizeToken = async () => {
    try {
      const judge = await window.lhic.judge.authorizeToken(judgeToken);
      const [catalog, packages] = await Promise.all([
        window.lhic.judge.catalog(),
        window.lhic.judge.policyPackages(),
      ]);
      setSession(judge.subject);
      setAssets(catalog);
      setPolicyPackages(packages);
      setJudgeToken("");
      setNotice(`Judge Center unlocked through ${judge.subject}.`);
    } catch (error) {
      setNotice(message(error));
    }
  };
  return (
    <div className="stack">
      <section className="panel hero">
        <span className="eyebrow">GITHUB OAUTH OR ISSUED TOKEN</span>
        <h2>Verified evaluation evidence</h2>
        <p>
          Judge Center unlocks after Appwrite verifies the GitHub provider email
          or numeric ID allowlist, or validates an administrator-issued token.
        </p>
        <div className="actions">
          <button
            className="button primary"
            onClick={() => void beginGithubLogin()}
          >
            Sign in with GitHub
          </button>
          <button className="button" onClick={() => void checkAccess()}>
            Check judge access
          </button>
          {session ? (
            <span className="verified">VERIFIED JUDGE: {session}</span>
          ) : null}
        </div>
        <div className="form-row">
          <label>
            Administrator-issued judge token
            <input
              type="password"
              value={judgeToken}
              onChange={(event) => setJudgeToken(event.target.value)}
              autoComplete="off"
              placeholder="lhic_judge_…"
            />
          </label>
          <button className="button" onClick={() => void authorizeToken()}>
            Unlock with token
          </button>
        </div>
      </section>
      <section className="panel">
        <PanelTitle code="GUIDED/07" title="Demo route" />
        {session ? (
          <ol className="demo-list">
            <GuidedDemoStep
              title="Fast / Slow Path"
              detail="Compare a deterministic local plan with an approval-gated provider proposal."
              onOpen={() => navigate("tasks")}
            />
            <GuidedDemoStep
              title="Skill lifecycle"
              detail="Inspect local and shared Skill state, synchronization, and verified export."
              onOpen={() => navigate("skills")}
            />
            <GuidedDemoStep
              title="MCP installation preview"
              detail="Review the exact configuration diff, backup, confirmation, and health probe."
              onOpen={() => navigate("mcp")}
            />
            <GuidedDemoStep
              title="Game Lab evidence"
              detail="Show the local-only recording boundary, emergency stops, and policy package review path."
              onOpen={() => navigate("game")}
            />
            <GuidedDemoStep
              title="Safety controls"
              detail="Review the bounded Slow Path profile and the approval, verifier, and redaction invariants."
              onOpen={() => navigate("security")}
            />
            <GuidedDemoStep
              title="Shared review and revocation"
              detail="Show the administrator review queue, revoked Skills, policy packages, and demo keys."
              onOpen={() => navigate("admin")}
            />
          </ol>
        ) : (
          <p className="muted">
            Sign in with an allowlisted GitHub identity to unlock the guided
            production demo route.
          </p>
        )}
      </section>
      <section className="panel">
        <PanelTitle code="POLICY/READ-ONLY" title="Approved game policies" />
        {policyPackages.length === 0 ? (
          <p className="muted">
            No approved policy packages are available to this judge identity.
          </p>
        ) : (
          <div className="table">
            {policyPackages.map((policyPackage) => (
              <div className="table-row" key={policyPackage.id}>
                <strong>{policyPackage.profileId}</strong>
                <span className="tag">{policyPackage.core.toUpperCase()}</span>
                <span>{policyPackage.version}</span>
                <a
                  href={policyPackage.bundleUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open verified package
                </a>
                <small>ZIP SHA-256: {policyPackage.bundleSha256}</small>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <PanelTitle
          code="BENCHMARK/READ-ONLY"
          title="Evidence catalog"
          action={
            <button className="button" onClick={() => void refreshCatalog()}>
              Refresh catalog
            </button>
          }
        />
        {assets.length === 0 ? (
          <p className="muted">
            Sign in with an allowlisted GitHub identity to load the deployed
            benchmark, trace, presentation, guide, and report assets.
          </p>
        ) : (
          <div className="table">
            {assets.map((asset) => (
              <div className="table-row" key={asset.id}>
                <strong>{asset.title}</strong>
                <span className="tag">{asset.kind}</span>
                <span>{asset.generatedAt}</span>
                <a href={asset.sourceUrl} target="_blank" rel="noreferrer">
                  Open source
                </a>
                <small>SHA-256: {asset.sha256}</small>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function GuidedDemoStep({
  title,
  detail,
  onOpen,
}: {
  title: string;
  detail: string;
  onOpen: () => void;
}): JSX.Element {
  return (
    <li>
      <b>{title}</b>
      <span>{detail}</span>
      <button className="button ghost" onClick={onOpen}>
        Open
      </button>
    </li>
  );
}

function Admin({
  setNotice,
}: {
  setNotice: (value: string) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] =
    useState<Awaited<ReturnType<typeof window.lhic.admin.snapshot>>>();
  const [judge, setJudge] = useState<{
    kind: "github-user-id" | "github-email";
    githubUserId: string;
    githubEmail: string;
    label: string;
    expiresAt: string;
  }>({
    kind: "github-email",
    githubUserId: "",
    githubEmail: "",
    label: "",
    expiresAt: "",
  });
  const [judgeToken, setJudgeToken] = useState({
    label: "",
    expiresAt: "",
    maxUses: "",
  });
  const [revealedJudgeToken, setRevealedJudgeToken] = useState<string>();
  const [demoKey, setDemoKey] = useState({
    label: "",
    scopes: "judge:demo",
    expiresAt: "",
    maxUses: "",
  });
  const [revealedKey, setRevealedKey] = useState<string>();
  const [secret, setSecret] = useState({
    label: "",
    kind: "appwrite",
    value: "",
  });
  const [asset, setAsset] = useState<{
    title: string;
    kind: JudgeDemoAsset["kind"];
    sourceUrl: string;
    generatedAt: string;
    sha256: string;
    metadata: string;
  }>({
    title: "",
    kind: "benchmark" as const,
    sourceUrl: "",
    generatedAt: "",
    sha256: "",
    metadata: "{}",
  });
  const load = async () => {
    try {
      const result = await window.lhic.admin.snapshot();
      setSnapshot(result);
      setNotice(
        `Administrator session verified for ${result.session.accountId}.`,
      );
    } catch (error) {
      setNotice(message(error));
    }
  };
  const createJudge = async () => {
    try {
      await window.lhic.admin.createJudge({
        kind: judge.kind,
        ...(judge.kind === "github-user-id"
          ? { githubUserId: judge.githubUserId }
          : { githubEmail: judge.githubEmail }),
        label: judge.label,
        ...(judge.expiresAt ? { expiresAt: judge.expiresAt } : {}),
      });
      setNotice(
        `GitHub ${judge.kind === "github-email" ? "email" : "numeric-ID"} judge grant created.`,
      );
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const createJudgeToken = async () => {
    try {
      const created = await window.lhic.admin.createJudgeToken({
        label: judgeToken.label,
        ...(judgeToken.expiresAt ? { expiresAt: judgeToken.expiresAt } : {}),
        ...(judgeToken.maxUses ? { maxUses: Number(judgeToken.maxUses) } : {}),
      });
      setRevealedJudgeToken(created.token);
      setNotice(
        "Judge authorization token created. Copy it now; it is not retrievable later.",
      );
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const revokeJudgeToken = async (id: string) => {
    try {
      await window.lhic.admin.revokeJudgeToken(id);
      setNotice("Judge authorization token revoked.");
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const revokeJudge = async (id: string) => {
    try {
      await window.lhic.admin.revokeJudge(id);
      setNotice("GitHub judge grant revoked.");
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const review = async (
    id: string,
    status: "approved" | "rejected" | "revoked",
  ) => {
    try {
      await window.lhic.admin.setSkillStatus(id, status);
      setNotice(`Shared Skill marked ${status}.`);
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const reviewPolicyPackage = async (
    id: string,
    status: "approved" | "rejected" | "revoked",
  ) => {
    try {
      await window.lhic.admin.setPolicyPackageStatus(id, status);
      setNotice(`Game policy package marked ${status}.`);
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const createDemoKey = async () => {
    try {
      const result = await window.lhic.admin.createDemoKey({
        label: demoKey.label,
        scopes: demoKey.scopes
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
        ...(demoKey.expiresAt ? { expiresAt: demoKey.expiresAt } : {}),
        ...(demoKey.maxUses ? { maxUses: Number(demoKey.maxUses) } : {}),
      });
      setRevealedKey(result.key);
      setNotice(
        "Demo API key created. Copy the value now; it cannot be shown again.",
      );
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const revokeDemoKey = async (id: string) => {
    try {
      await window.lhic.admin.revokeDemoKey(id);
      setNotice("Demo API key revoked.");
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const createSecret = async () => {
    try {
      await window.lhic.admin.createSecret({
        label: secret.label,
        kind: secret.kind,
        secret: secret.value,
      });
      setSecret({ ...secret, value: "" });
      setNotice(
        "Credential encrypted by the control plane. Only metadata can be read back.",
      );
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const revokeSecret = async (id: string) => {
    try {
      await window.lhic.admin.revokeSecret(id);
      setNotice("Shared-library credential revoked.");
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const createAsset = async () => {
    try {
      await window.lhic.admin.createAsset({
        title: asset.title,
        kind: asset.kind,
        sourceUrl: asset.sourceUrl,
        generatedAt: asset.generatedAt,
        sha256: asset.sha256,
        metadata: JSON.parse(asset.metadata) as Record<string, unknown>,
      });
      setNotice(
        "Demo asset registered with its source, generation time, and integrity digest.",
      );
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  const retireAsset = async (id: string) => {
    try {
      await window.lhic.admin.retireAsset(id);
      setNotice("Demo asset retired from the judge catalog.");
      await load();
    } catch (error) {
      setNotice(message(error));
    }
  };
  return (
    <div className="stack">
      <section className="panel">
        <PanelTitle
          code="ADMIN/08"
          title="Cloud control plane"
          action={
            <button className="button primary" onClick={() => void load()}>
              Verify administrator access
            </button>
          }
        />
        <p className="muted">
          The deployed Function accepts only authenticated Appwrite JWTs. The
          bootstrap Appwrite account manages roles, GitHub email or numeric-ID
          judge grants, revocable judge tokens, skill review, encrypted registry
          credential metadata and demo API-key policy.
        </p>
        <div className="boundary compact">
          <div>
            <b>ROLE</b>
            <span>
              Bootstrap admin
              <br />
              then explicit grants
            </span>
          </div>
          <div>
            <b>JUDGE</b>
            <span>
              GitHub email or UID
              <br />
              OAuth identity only
            </span>
          </div>
          <div>
            <b>KEY</b>
            <span>
              Hash only
              <br />
              show once on creation
            </span>
          </div>
        </div>
      </section>
      {snapshot ? (
        <>
          <section className="panel">
            <PanelTitle code="JUDGE/GRANT" title="GitHub reviewer allowlist" />
            <div className="form-grid">
              <label>
                Allowlist type
                <select
                  value={judge.kind}
                  onChange={(event) =>
                    setJudge({
                      ...judge,
                      kind: event.target.value as
                        "github-user-id" | "github-email",
                    })
                  }
                >
                  <option value="github-email">Verified GitHub email</option>
                  <option value="github-user-id">GitHub numeric ID</option>
                </select>
              </label>
              <label>
                {judge.kind === "github-email"
                  ? "GitHub email"
                  : "GitHub numeric ID"}
                <input
                  value={
                    judge.kind === "github-email"
                      ? judge.githubEmail
                      : judge.githubUserId
                  }
                  onChange={(event) =>
                    setJudge(
                      judge.kind === "github-email"
                        ? { ...judge, githubEmail: event.target.value }
                        : { ...judge, githubUserId: event.target.value },
                    )
                  }
                />
              </label>
              <label>
                Reviewer label
                <input
                  value={judge.label}
                  onChange={(event) =>
                    setJudge({ ...judge, label: event.target.value })
                  }
                />
              </label>
              <label>
                Expires at (optional)
                <input
                  type="datetime-local"
                  value={judge.expiresAt}
                  onChange={(event) =>
                    setJudge({ ...judge, expiresAt: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button className="button" onClick={() => void createJudge()}>
                Grant judge access
              </button>
            </div>
            <div className="table">
              {snapshot.judges.map((grant) => (
                <div className="table-row" key={grant.id}>
                  <strong>{grant.label}</strong>
                  <span>{grant.githubEmail ?? grant.githubUserId}</span>
                  <span
                    className={`status ${grant.active ? "approved" : "revoked"}`}
                  >
                    {grant.active ? "active" : "revoked"}
                  </span>
                  <span>{grant.expiresAt ?? "No expiry"}</span>
                  {grant.active ? (
                    <button
                      className="button ghost"
                      onClick={() => void revokeJudge(grant.id)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <PanelTitle
              code="JUDGE/TOKEN"
              title="Administrator-issued judge tokens"
            />
            <p className="muted">
              The raw token is shown only once, stored only as a SHA-256 hash,
              and can be revoked immediately.
            </p>
            <div className="form-grid">
              <label>
                Token label
                <input
                  value={judgeToken.label}
                  onChange={(event) =>
                    setJudgeToken({ ...judgeToken, label: event.target.value })
                  }
                />
              </label>
              <label>
                Expires at (optional)
                <input
                  type="datetime-local"
                  value={judgeToken.expiresAt}
                  onChange={(event) =>
                    setJudgeToken({
                      ...judgeToken,
                      expiresAt: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                Maximum requests (optional)
                <input
                  inputMode="numeric"
                  value={judgeToken.maxUses}
                  onChange={(event) =>
                    setJudgeToken({
                      ...judgeToken,
                      maxUses: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button
                className="button"
                onClick={() => void createJudgeToken()}
              >
                Create judge token
              </button>
              {revealedJudgeToken ? (
                <code className="revealed-key">{revealedJudgeToken}</code>
              ) : null}
            </div>
            <div className="table">
              {snapshot.judgeTokens.map((token) => (
                <div className="table-row" key={token.id}>
                  <strong>{token.label}</strong>
                  <span>
                    {token.maxUses ? `${token.maxUses} requests` : "No limit"}
                  </span>
                  <span>{token.expiresAt ?? "No expiry"}</span>
                  <span
                    className={`status ${token.revokedAt ? "revoked" : "approved"}`}
                  >
                    {token.revokedAt ? "revoked" : "active"}
                  </span>
                  {!token.revokedAt ? (
                    <button
                      className="button ghost"
                      onClick={() => void revokeJudgeToken(token.id)}
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <PanelTitle code="SKILL/REVIEW" title="Shared Skill review queue" />
            <div className="table">
              {snapshot.skills.map((skill) => (
                <div className="table-row" key={skill.id}>
                  <strong>{skill.name}</strong>
                  <span className={`status ${skill.status}`}>
                    {skill.status}
                  </span>
                  <span>
                    {skill.fastPathEligible ? "FAST-READY" : "NOT FAST-PATH"}
                  </span>
                  {skill.status === "pending" ? (
                    <span className="actions">
                      <button
                        className="button"
                        onClick={() => void review(skill.id, "approved")}
                      >
                        Approve
                      </button>
                      <button
                        className="button ghost"
                        onClick={() => void review(skill.id, "rejected")}
                      >
                        Reject
                      </button>
                    </span>
                  ) : (
                    <button
                      className="button ghost"
                      onClick={() => void review(skill.id, "revoked")}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <PanelTitle code="POLICY/REVIEW" title="Game policy review queue" />
            <p className="muted">
              Review only the verified policy bundle URL and integrity metadata.
              Frame captures, datasets, input events, and raw recordings are not
              stored by the control plane.
            </p>
            <div className="table">
              {snapshot.policyPackages.map((policyPackage) => (
                <div className="table-row" key={policyPackage.id}>
                  <strong>{policyPackage.profileId}</strong>
                  <span className="tag">
                    {policyPackage.core.toUpperCase()} · {policyPackage.version}
                  </span>
                  <span className={`status ${policyPackage.status}`}>
                    {policyPackage.status}
                  </span>
                  <small>ZIP: {policyPackage.bundleSha256}</small>
                  {policyPackage.status === "pending" ? (
                    <span className="actions">
                      <button
                        className="button"
                        onClick={() =>
                          void reviewPolicyPackage(policyPackage.id, "approved")
                        }
                      >
                        Approve
                      </button>
                      <button
                        className="button ghost"
                        onClick={() =>
                          void reviewPolicyPackage(policyPackage.id, "rejected")
                        }
                      >
                        Reject
                      </button>
                    </span>
                  ) : policyPackage.status !== "revoked" ? (
                    <button
                      className="button ghost"
                      onClick={() =>
                        void reviewPolicyPackage(policyPackage.id, "revoked")
                      }
                    >
                      Revoke
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <PanelTitle code="DEMO/KEY" title="Judge demo API keys" />
            <div className="form-grid">
              <label>
                Label
                <input
                  value={demoKey.label}
                  onChange={(event) =>
                    setDemoKey({ ...demoKey, label: event.target.value })
                  }
                />
              </label>
              <label>
                Scopes (comma-separated)
                <input
                  value={demoKey.scopes}
                  onChange={(event) =>
                    setDemoKey({ ...demoKey, scopes: event.target.value })
                  }
                />
              </label>
              <label>
                Expires at (optional)
                <input
                  type="datetime-local"
                  value={demoKey.expiresAt}
                  onChange={(event) =>
                    setDemoKey({ ...demoKey, expiresAt: event.target.value })
                  }
                />
              </label>
              <label>
                Maximum uses (optional)
                <input
                  inputMode="numeric"
                  value={demoKey.maxUses}
                  onChange={(event) =>
                    setDemoKey({ ...demoKey, maxUses: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button
                className="button primary"
                onClick={() => void createDemoKey()}
              >
                Create demo key
              </button>
              {revealedKey ? <code>{revealedKey}</code> : null}
            </div>
            <p className="muted">
              The value is shown once in this desktop session. The control plane
              stores only its SHA-256 hash.
            </p>
            <div className="table">
              {snapshot.demoKeys.map((key) => (
                <div className="table-row" key={key.id}>
                  <strong>{key.label}</strong>
                  <span>{key.scopes.join(", ")}</span>
                  <span>{key.expiresAt ?? "No expiry"}</span>
                  {key.revokedAt ? (
                    <span className="status revoked">REVOKED</span>
                  ) : (
                    <button
                      className="button ghost"
                      onClick={() => void revokeDemoKey(key.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <PanelTitle
              code="CREDENTIAL/METADATA"
              title="Shared-library credentials"
            />
            <p className="muted">
              Credential plaintext is accepted only for encrypted control-plane
              storage and is never returned to this application, task traces, or
              catalog responses.
            </p>
            <div className="form-grid">
              <label>
                Label
                <input
                  value={secret.label}
                  onChange={(event) =>
                    setSecret({ ...secret, label: event.target.value })
                  }
                />
              </label>
              <label>
                Credential type
                <input
                  value={secret.kind}
                  onChange={(event) =>
                    setSecret({ ...secret, kind: event.target.value })
                  }
                />
              </label>
              <label>
                Credential value
                <input
                  type="password"
                  autoComplete="off"
                  value={secret.value}
                  onChange={(event) =>
                    setSecret({ ...secret, value: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button
                className="button primary"
                onClick={() => void createSecret()}
              >
                Store encrypted credential
              </button>
            </div>
            <div className="table">
              {snapshot.secrets.map((metadata) => (
                <div className="table-row" key={metadata.id}>
                  <strong>{metadata.label}</strong>
                  <span>{metadata.kind}</span>
                  <span>{metadata.keyVersion}</span>
                  {metadata.revokedAt ? (
                    <span className="status revoked">REVOKED</span>
                  ) : (
                    <button
                      className="button ghost"
                      onClick={() => void revokeSecret(metadata.id)}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
          <section className="panel">
            <PanelTitle code="ASSET/CATALOG" title="Judge evidence assets" />
            <p className="muted">
              Register only completed benchmark, trace, presentation, guide, or
              report output. Judge Center publishes active records unchanged and
              displays their supplied source and generation time.
            </p>
            <div className="form-grid">
              <label>
                Title
                <input
                  value={asset.title}
                  onChange={(event) =>
                    setAsset({ ...asset, title: event.target.value })
                  }
                />
              </label>
              <label>
                Kind
                <select
                  value={asset.kind}
                  onChange={(event) =>
                    setAsset({
                      ...asset,
                      kind: event.target.value as JudgeDemoAsset["kind"],
                    })
                  }
                >
                  <option value="benchmark">Benchmark</option>
                  <option value="trace">Trace</option>
                  <option value="presentation">Presentation</option>
                  <option value="guide">Guide</option>
                  <option value="report">Report</option>
                </select>
              </label>
              <label>
                HTTPS source URL
                <input
                  type="url"
                  value={asset.sourceUrl}
                  onChange={(event) =>
                    setAsset({ ...asset, sourceUrl: event.target.value })
                  }
                />
              </label>
              <label>
                Generated at
                <input
                  type="datetime-local"
                  value={asset.generatedAt}
                  onChange={(event) =>
                    setAsset({ ...asset, generatedAt: event.target.value })
                  }
                />
              </label>
              <label>
                SHA-256
                <input
                  value={asset.sha256}
                  onChange={(event) =>
                    setAsset({ ...asset, sha256: event.target.value })
                  }
                />
              </label>
              <label>
                Non-sensitive metadata JSON
                <textarea
                  value={asset.metadata}
                  onChange={(event) =>
                    setAsset({ ...asset, metadata: event.target.value })
                  }
                />
              </label>
            </div>
            <div className="actions">
              <button
                className="button primary"
                onClick={() => void createAsset()}
              >
                Register evidence asset
              </button>
            </div>
            <div className="table">
              {snapshot.assets.map((registered) => (
                <div className="table-row" key={registered.id}>
                  <strong>{registered.title}</strong>
                  <span className="tag">{registered.kind}</span>
                  <span>{registered.generatedAt}</span>
                  {registered.retiredAt ? (
                    <span className="status revoked">RETIRED</span>
                  ) : (
                    <button
                      className="button ghost"
                      onClick={() => void retireAsset(registered.id)}
                    >
                      Retire
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      ) : null}
      <section className="panel">
        <PanelTitle code="ASSETS" title="Hackathon materials" />
        <p className="muted">
          The production control plane serves only current benchmark reports,
          trace summaries, presentations and judge documentation with source and
          creation timestamps.
        </p>
      </section>
    </div>
  );
}

function PanelTitle({
  code,
  title,
  action,
}: {
  code: string;
  title: string;
  action?: JSX.Element;
}): JSX.Element {
  return (
    <div className="panel-title">
      <div>
        <span>{code}</span>
        <h2>{title}</h2>
      </div>
      {action}
    </div>
  );
}
function EventRow({ event }: { event: CommandEvent }): JSX.Element {
  return (
    <li className="event-row">
      <span className={`status ${event.status}`}>
        {event.status.replaceAll("_", " ")}
      </span>
      <div>
        <b>{event.message}</b>
        <small title={event.createdAt}>
          {formatTimestamp(event.createdAt)}
        </small>
      </div>
    </li>
  );
}
function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The local control surface could not complete that operation.";
}
