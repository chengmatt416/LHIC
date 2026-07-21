import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import type {
  CommandEvent,
  DemoCandidateStatus,
  DemoCodexRunStatus,
  DemoDirectorPreflight,
  DemoRecordingStatus,
  DesktopProgressEvent,
} from "../shared/contracts.js";
import {
  advanceDemoStage,
  elapsedMs,
  initialDemoDirectorState,
  type DemoStage,
  type DemoDirectorState,
} from "./demo-director-model.js";

interface DemoDirectorProps {
  setNotice: (value: string) => void;
}

const terminalTaskStatuses = new Set<CommandEvent["status"]>([
  "completed",
  "failed",
  "cancelled",
  "blocked",
]);

export function DemoDirector({ setNotice }: DemoDirectorProps): JSX.Element {
  const [director, setDirector] = useState<DemoDirectorState>(
    initialDemoDirectorState,
  );
  const [preflight, setPreflight] = useState<DemoDirectorPreflight>();
  const [recording, setRecording] = useState<DemoRecordingStatus>({
    recording: false,
  });
  const [savedClips, setSavedClips] = useState<string[]>([]);
  const [savingClip, setSavingClip] = useState(false);
  const [candidates, setCandidates] = useState<DemoCandidateStatus[]>([]);
  const recordingStartRequested = useRef(false);
  const completionReported = useRef(false);
  const statusPollPending = useRef(false);
  const approver = "demo-operator";
  const gameArtifact =
    ".lhic/game-training/3d/skills/epic-shooter-stability-v1/artifact.json";
  const [evidence, setEvidence] = useState<string[]>([]);
  const [slowComplete, setSlowComplete] = useState(false);
  const [codexStatus, setCodexStatus] = useState<DemoCodexRunStatus>({
    status: "idle",
  });
  const [fastEvent, setFastEvent] = useState<CommandEvent>();
  const [, setClock] = useState(0);

  const newestCandidate = candidates[0];
  const fastEligible = candidates.some((candidate) => candidate.promoted);
  const fastComplete = fastEvent?.status === "completed";

  const refreshCandidates = useCallback(async () => {
    const next = await window.lhic.demo.candidates();
    setCandidates(next);
  }, []);

  const refreshCodexStatus = useCallback(async () => {
    if (statusPollPending.current) return;
    statusPollPending.current = true;
    try {
      const next = await window.lhic.demo.codexRunStatus();
      setCodexStatus(next);
      if (next.status === "completed" && !completionReported.current) {
        completionReported.current = true;
        setSlowComplete(true);
        setDirector((state) => ({
          ...state,
          slow: { ...state.slow, completedAt: Date.now() },
        }));
        await window.lhic.demo.stopTimer();
        await window.lhic.demo.focusLhic();
        setNotice(
          "Codex MCP session exited successfully. Press Space to confirm completion and open learning.",
        );
      } else if (next.status === "failed" && !completionReported.current) {
        completionReported.current = true;
        await window.lhic.demo.stopTimer();
        await window.lhic.demo.focusLhic();
        setNotice(
          `Codex CLI exited with status ${next.exitCode ?? "unknown"}. Review Terminal before continuing.`,
        );
      }
    } finally {
      statusPollPending.current = false;
    }
  }, [setNotice]);

  useEffect(() => {
    if (recordingStartRequested.current) return;
    recordingStartRequested.current = true;
    void Promise.all([
      window.lhic.demo.preflight().then(setPreflight),
      window.lhic.demo.startRecording().then(setRecording),
      window.lhic.demo.candidates().then(setCandidates),
    ]).catch((error: unknown) => setNotice(message(error)));
  }, [setNotice]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClock((value) => value + 1);
      if (["slow-live", "learning"].includes(director.stage)) {
        void refreshCandidates().catch(() => undefined);
      }
      if (director.stage === "slow-live") {
        void refreshCodexStatus().catch(() => undefined);
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [director.stage, refreshCandidates, refreshCodexStatus]);

  useEffect(
    () =>
      window.lhic.events.onProgress((update: DesktopProgressEvent) => {
        if (update.channel === "training") {
          if (
            update.job.kind === "game-play" &&
            ["completed", "failed", "cancelled"].includes(update.job.status)
          ) {
            void window.lhic.demo
              .focusLhic()
              .then(() =>
                setDirector((state) =>
                  state.stage === "game"
                    ? { ...state, stage: "slide-4" }
                    : state,
                ),
              );
          }
          return;
        }
        if (fastEvent && update.task.commandId === fastEvent.commandId) {
          setFastEvent(update.task);
          if (update.task.status === "completed") {
            void window.lhic.demo.stopTimer();
            setDirector((state) => ({
              ...state,
              fast: { ...state.fast, completedAt: Date.now() },
            }));
          }
        }
        setEvidence((current) => [
          ...current.slice(-10),
          `${update.task.status.toUpperCase()} · ${update.task.message}`,
          ...(update.task.evidence ?? []).slice(-2),
        ]);
      }),
    [fastEvent],
  );

  const advance = useCallback(async () => {
    const stage = director.stage;
    if (stage === "slide-1") {
      setDirector((state) => advanceDemoStage(state));
      return;
    }
    if (stage === "slow-approval") {
      await dispatchSlowPath();
      return;
    }
    if (stage === "slow-live") {
      await markSlowComplete();
      return;
    }
    if (stage === "fast-ready") {
      await startFastPath();
      return;
    }
    if (stage === "fast-live") {
      if (!fastEvent) return;
      if (fastEvent.status === "proposed") {
        setFastEvent(await window.lhic.tasks.execute(fastEvent.commandId));
      } else if (fastEvent.status === "awaiting_approval") {
        setFastEvent(await window.lhic.tasks.approve(fastEvent.commandId));
      } else if (fastEvent.status === "completed") {
        setDirector((state) => advanceDemoStage(state, { fastComplete: true }));
      }
      return;
    }
    if (stage === "slide-3") {
      setDirector((state) => advanceDemoStage(state));
      const result = await window.lhic.demo.launchChallenge();
      setEvidence((current) => [...current.slice(-10), ...result.evidence]);
      if (result.status === "failed") {
        setNotice(result.error ?? "Game launch failed.");
        return;
      }
      try {
        const job = await window.lhic.game.run({
          core: "3d",
          action: "play",
          profileId: "challenge-2026",
          resourcePath: gameArtifact,
        });
        setEvidence((current) => [
          ...current.slice(-10),
          `Game policy ${job.id} is ${job.status}.`,
        ]);
      } catch (error) {
        setNotice(message(error));
      }
      return;
    }
    if (stage === "slide-4") {
      await window.lhic.demo.stopTimer();
      if (recording.recording) {
        const stopped = await window.lhic.demo.stopRecording();
        setRecording(stopped);
        setNotice(
          `Recording saved to ${stopped.outputPath ?? "the Downloads folder"}.`,
        );
      }
      setDirector((state) => advanceDemoStage(state));
      return;
    }
    setDirector((state) =>
      advanceDemoStage(state, { slowComplete, fastComplete, fastEligible }),
    );
  }, [
    director.stage,
    fastComplete,
    fastEligible,
    fastEvent,
    recording.recording,
    slowComplete,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, button")) return;
      event.preventDefault();
      void advance();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advance]);

  const dispatchSlowPath = async () => {
    if (!preflight?.scenarioReady) {
      setNotice(
        "Private demo identities are missing. Restart with the four LHIC_DEMO_* identity variables.",
      );
      return;
    }
    setDirector((state) => ({
      ...state,
      stage: "slow-live",
      slow: { startedAt: Date.now() },
    }));
    completionReported.current = false;
    setSlowComplete(false);
    setCodexStatus({ status: "running" });
    try {
      await window.lhic.demo.startTimer("slow");
      const result = await window.lhic.demo.dispatchCodex({
        approvedBy: approver,
      });
      setEvidence(result.evidence);
      if (result.status === "failed") {
        await window.lhic.demo.stopTimer();
        setNotice(result.error ?? "Codex CLI dispatch failed.");
        setDirector((state) => ({ ...state, stage: "slow-approval" }));
      } else {
        setNotice(
          "Codex CLI started with LHIC MCP; Terminal now shows the live run.",
        );
      }
    } catch (error) {
      await window.lhic.demo.stopTimer().catch(() => undefined);
      setNotice(message(error));
      setDirector((state) => ({ ...state, stage: "slow-approval" }));
    }
  };

  const markSlowComplete = async () => {
    await window.lhic.demo.stopTimer();
    setSlowComplete(true);
    setEvidence((current) => [
      ...current.slice(-10),
      "Human operator confirmed the Slow Path demonstration is complete.",
    ]);
    setDirector((state) => ({
      ...state,
      stage: "learning",
      slow: { ...state.slow, completedAt: Date.now() },
    }));
    await refreshCandidates();
  };

  async function startFastPath(): Promise<void> {
    if (!fastEligible) return;
    const startedAt = Date.now();
    await window.lhic.demo.startTimer("fast");
    let event: CommandEvent;
    try {
      event = await window.lhic.demo.startFastPath();
    } catch (error) {
      await window.lhic.demo.stopTimer().catch(() => undefined);
      throw error;
    }
    setFastEvent(event);
    setDirector((state) => ({
      ...state,
      stage: "fast-live",
      fast: { startedAt },
    }));
    setEvidence((current) => [
      ...current.slice(-10),
      ...(event.evidence ?? []),
    ]);
    if (terminalTaskStatuses.has(event.status)) {
      await window.lhic.demo.stopTimer();
      setDirector((state) => ({
        ...state,
        fast: { ...state.fast, completedAt: Date.now() },
      }));
    }
  }

  async function saveCurrentClip(): Promise<void> {
    if (!recording.recording || savingClip) return;
    setSavingClip(true);
    try {
      const result = await window.lhic.demo.saveRecordingClip();
      setSavedClips((current) => [...current, result.savedClipPath]);
      setRecording(result.recording);
      setNotice(
        `Clip saved to ${result.savedClipPath}. Recording continued in a new segment.`,
      );
    } catch (error) {
      setNotice(message(error));
    } finally {
      setSavingClip(false);
    }
  }

  async function jumpToSection(stage: DemoStage): Promise<void> {
    if (stage === "fast-ready" && !fastEligible) {
      setNotice(
        "Fast Path remains locked until the vendor Skill has real promotion evidence.",
      );
      return;
    }
    await window.lhic.demo.stopTimer().catch(() => undefined);
    setDirector((state) => ({ ...state, stage }));
    setNotice(
      "Presentation section changed. Recording continues; active automation was not cancelled.",
    );
  }

  if (director.stage.startsWith("slide-")) {
    const slide = director.stage.at(-1);
    return (
      <section className="demo-director slide-stage" tabIndex={-1}>
        <img
          src={`./demo/slide-${slide}.png`}
          alt={`Presentation slide ${slide}`}
        />
        <DemoHud
          stage={director.stage}
          recording={recording}
          savingClip={savingClip}
          onSaveClip={saveCurrentClip}
          onJump={jumpToSection}
        />
      </section>
    );
  }

  if (director.stage === "complete") {
    return (
      <section className="demo-director demo-complete">
        <span className="demo-kicker">DEMO COMPLETE</span>
        <h2>Recording stopped and saved to Downloads.</h2>
        {[...savedClips, recording.outputPath]
          .filter((path): path is string => Boolean(path))
          .map((path) => (
            <p key={path}>{path}</p>
          ))}
      </section>
    );
  }

  return (
    <section className="demo-director" tabIndex={-1}>
      <header className="demo-header">
        <div>
          <span className="demo-kicker">LHIC / DEMO DIRECTOR</span>
          <h2>{stageTitle(director.stage)}</h2>
        </div>
        <div className="demo-header-badges">
          <span
            className={recording.recording ? "demo-badge live" : "demo-badge"}
          >
            {recording.recording ? "● REC" : "NOT RECORDING"}
          </span>
          <span className="demo-badge">SPACE · NEXT</span>
          <PresenterControls
            stage={director.stage}
            recording={recording}
            savingClip={savingClip}
            onSaveClip={saveCurrentClip}
            onJump={jumpToSection}
          />
        </div>
      </header>

      {director.stage === "mcp-link" && (
        <div className="demo-grid two">
          <DemoCard title="Codex ↔ LHIC MCP" code="CONNECTION">
            <p
              className={`demo-hero-status ${preflight?.codexMcp.status ?? "manual"}`}
            >
              {preflight?.codexMcp.status.toUpperCase() ?? "CHECKING"}
            </p>
            <p className="demo-warning">
              Codex CLI runs with its dangerous approval and sandbox bypass.
              LHIC still enforces signed action policy and verifier evidence.
            </p>
            <p>
              {preflight?.codexMcp.message ?? "Running local MCP health probe…"}
            </p>
            <ul className="demo-checks">
              <li data-ok={preflight?.codexApplicationAvailable}>
                Codex CLI detected
              </li>
              <li data-ok={preflight?.challengeApplicationAvailable}>
                Challenge 2026 detected
              </li>
              <li data-ok={preflight?.screenRecorderAvailable}>
                Local recorder detected
              </li>
            </ul>
          </DemoCard>
          <DemoCard title="Execution boundary" code="PROOF">
            <div className="demo-boundary">
              <b>CODEX</b>
              <span>intent + Slow Path MCP calls</span>
              <i>→</i>
              <b>LHIC</b>
              <span>DOM actions + approvals + verifier</span>
            </div>
            <p className="demo-callout">
              Codex never receives a browser-control handle.
            </p>
          </DemoCard>
        </div>
      )}

      {director.stage === "slow-approval" && (
        <div className="demo-grid two">
          <DemoCard title="Approve Codex dispatch" code="SIGNED PLAN">
            <div className="approval-plan">
              <p>
                <b>1</b> Verify LHIC MCP in Codex CLI
              </p>
              <p>
                <b>2</b> Launch {preflight?.codexModel ?? "gpt-5.6-luna"} ·
                medium
              </p>
              <p>
                <b>3</b> Submit the approved Slow Path prompt
              </p>
              <p>
                <b>4</b> Focus Terminal for the live recording
              </p>
            </div>
            <p
              className={
                preflight?.scenarioReady ? "demo-callout" : "demo-warning"
              }
            >
              {preflight?.scenarioReady
                ? "Sandbox identities loaded in memory; they will not appear in this UI or evidence feed."
                : "Private identities are missing from the launch environment."}
            </p>
            <p className="space-instruction">
              SPACE · APPROVE SIGNED PLAN & RUN IN CODEX
            </p>
          </DemoCard>
          <DemoCard title="Certification validation" code="SECURITY LIVE">
            <SecurityFeed
              fingerprint={preflight?.signingCertificateSha256}
              evidence={evidence}
            />
          </DemoCard>
        </div>
      )}

      {director.stage === "slow-live" && (
        <div className="demo-grid live-layout">
          <TimerCard
            label="SLOW PATH"
            milliseconds={elapsedMs(director.slow)}
            accent="amber"
          />
          <DemoCard title="Live guarded execution" code="LHIC, NOT CODEX">
            <SecurityFeed
              fingerprint={preflight?.signingCertificateSha256}
              evidence={evidence}
            />
            <p className="demo-callout">
              Codex runs in Terminal without desktop Accessibility selectors.
              Codex confirmation prompts are bypassed. LHIC watches the real CLI
              exit status and marks this portal complete automatically.
            </p>
            <p
              className={`demo-hero-status ${codexStatus.status === "completed" ? "passed" : "manual"}`}
            >
              {codexStatus.status === "completed"
                ? "SESSION COMPLETED"
                : codexStatus.status.toUpperCase()}
            </p>
            <p className="space-instruction">SPACE · MARK SLOW PATH COMPLETE</p>
          </DemoCard>
        </div>
      )}

      {director.stage === "learning" && (
        <div className="demo-grid two">
          <DemoCard title="Slow Path → durable Skill" code="LEARNING">
            <LearningGates candidate={newestCandidate} />
            {!fastEligible && (
              <p className="demo-warning">
                Fast Path is intentionally locked. One demo run creates a
                candidate; promotion requires 3 distinct verifier-backed runs
                plus an unseen-UI holdout.
              </p>
            )}
          </DemoCard>
          <DemoCard title="Fast Path variation" code="PRIVATE INPUT">
            <p>Variation: Test3 ×2, Test2 ×1, increase Test stock to 21.</p>
            <p className="space-instruction">
              {fastEligible
                ? "SPACE · CONTINUE TO VERIFIED FAST PATH"
                : "WAITING FOR REAL PROMOTION EVIDENCE"}
            </p>
          </DemoCard>
        </div>
      )}

      {director.stage === "fast-ready" && (
        <DemoCard title="Model-free replay is armed" code="FAST PATH">
          <p className="demo-hero-status passed">0 LLM · 0 MCP</p>
          <p>
            Press Space to start the similar task directly in LHIC and focus its
            live Terminal evidence monitor. Codex remains outside the Fast Path
            execution path.
          </p>
        </DemoCard>
      )}

      {director.stage === "fast-live" && (
        <div className="demo-grid live-layout">
          <TimerCard
            label="FAST PATH"
            milliseconds={elapsedMs(director.fast)}
            accent="green"
          />
          <DemoCard
            title="Deterministic local execution"
            code="PLAYWRIGHT / CDP"
          >
            <p
              className={`demo-hero-status ${fastEvent?.status === "completed" ? "passed" : "manual"}`}
            >
              {fastEvent?.status.toUpperCase().replaceAll("_", " ") ??
                "STARTING"}
            </p>
            <p>{fastEvent?.message}</p>
            <SecurityFeed
              fingerprint={preflight?.signingCertificateSha256}
              evidence={evidence}
            />
            <p className="space-instruction">
              {fastEvent?.status === "awaiting_approval"
                ? "SPACE · APPROVE PENDING LHIC ACTION"
                : fastEvent?.status === "completed"
                  ? "SPACE · SHOW COMPARISON"
                  : "LHIC IS RUNNING LOCALLY"}
            </p>
          </DemoCard>
        </div>
      )}

      {director.stage === "comparison" && (
        <Comparison
          slowMs={elapsedMs(director.slow)}
          fastMs={elapsedMs(director.fast)}
        />
      )}

      {director.stage === "game" && (
        <DemoCard title="Challenge 2026" code="SAME GUARDED CORE">
          <p className="demo-hero-status passed">NATIVE TARGET VERIFIED</p>
          <p>
            Challenge2026.app and the approved Game Lab policy are running.
            Focus checks, action allowlists, and trace evidence remain active.
            LHIC returns to slide 4 automatically when playback ends.
          </p>
        </DemoCard>
      )}
    </section>
  );
}

function DemoHud({
  stage,
  recording,
  savingClip,
  onSaveClip,
  onJump,
}: {
  stage: DemoStage;
  recording: DemoRecordingStatus;
  savingClip: boolean;
  onSaveClip: () => Promise<void>;
  onJump: (stage: DemoStage) => Promise<void>;
}): JSX.Element {
  return (
    <div className="demo-hud">
      <span>{recording.recording ? "● RECORDING" : "RECORDING OFF"}</span>
      <PresenterControls
        stage={stage}
        recording={recording}
        savingClip={savingClip}
        onSaveClip={onSaveClip}
        onJump={onJump}
      />
      <span>
        {stage === "slide-1"
          ? "SPACE · NEXT"
          : stage === "slide-4"
            ? "SPACE · STOP RECORDING"
            : "SPACE · NEXT"}
      </span>
    </div>
  );
}

const sectionOptions: Array<{ stage: DemoStage; label: string }> = [
  { stage: "slide-1", label: "Slide 1" },
  { stage: "slide-2", label: "Slide 2" },
  { stage: "mcp-link", label: "MCP proof" },
  { stage: "slow-approval", label: "Slow Path" },
  { stage: "learning", label: "Learning" },
  { stage: "fast-ready", label: "Fast Path" },
  { stage: "comparison", label: "Comparison" },
  { stage: "slide-3", label: "Slide 3 / Game" },
  { stage: "slide-4", label: "Slide 4 / Finish" },
];

function PresenterControls({
  stage,
  recording,
  savingClip,
  onSaveClip,
  onJump,
}: {
  stage: DemoStage;
  recording: DemoRecordingStatus;
  savingClip: boolean;
  onSaveClip: () => Promise<void>;
  onJump: (stage: DemoStage) => Promise<void>;
}): JSX.Element {
  return (
    <div className="presenter-controls">
      <button
        type="button"
        disabled={!recording.recording || savingClip}
        onClick={() => void onSaveClip()}
      >
        {savingClip ? "SAVING…" : "SAVE CLIP"}
      </button>
      <label>
        <span>JUMP</span>
        <select
          value={sectionForStage(stage)}
          onChange={(event) => void onJump(event.target.value as DemoStage)}
        >
          {sectionOptions.map((section) => (
            <option key={section.stage} value={section.stage}>
              {section.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function sectionForStage(stage: DemoStage): DemoStage {
  if (stage === "slow-live") return "slow-approval";
  if (stage === "fast-live") return "fast-ready";
  if (stage === "game") return "slide-3";
  if (stage === "complete") return "slide-4";
  return stage;
}

function DemoCard({
  title,
  code,
  children,
}: {
  title: string;
  code: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <article className="demo-card">
      <span className="demo-kicker">{code}</span>
      <h3>{title}</h3>
      {children}
    </article>
  );
}

function TimerCard({
  label,
  milliseconds,
  accent,
}: {
  label: string;
  milliseconds: number;
  accent: "amber" | "green";
}): JSX.Element {
  return (
    <article className={`demo-timer ${accent}`}>
      <span>{label}</span>
      <strong>{formatDuration(milliseconds)}</strong>
      <small>measured from real runtime events</small>
    </article>
  );
}

function SecurityFeed({
  fingerprint,
  evidence,
}: {
  fingerprint: string | undefined;
  evidence: string[];
}): JSX.Element {
  return (
    <div className="security-feed">
      <p>
        <b>ED25519 CERT</b>{" "}
        {fingerprint
          ? `${fingerprint.slice(0, 12)}…${fingerprint.slice(-8)}`
          : "checking…"}
      </p>
      <p>
        <b>ACTION HASH</b> bound before dispatch
      </p>
      <p>
        <b>SIGNATURE</b> validated locally
      </p>
      <div className="security-stream">
        {evidence.length ? (
          evidence
            .slice(-6)
            .map((item, index) => (
              <span key={`${index}-${item}`}>✓ {item}</span>
            ))
        ) : (
          <span>Waiting for verifier evidence…</span>
        )}
      </div>
    </div>
  );
}

function LearningGates({
  candidate,
}: {
  candidate: DemoCandidateStatus | undefined;
}): JSX.Element {
  const runs = candidate?.verifiedRunCount ?? 0;
  return (
    <div className="learning-gates">
      <Gate label="Run 1" passed={runs >= 1} />
      <Gate label="Run 2" passed={runs >= 2} />
      <Gate label="Run 3" passed={runs >= 3} />
      <Gate
        label="Unseen UI holdout"
        passed={candidate?.holdoutPassed ?? false}
      />
      <Gate label="Fast Path promoted" passed={candidate?.promoted ?? false} />
    </div>
  );
}

function Gate({
  label,
  passed,
}: {
  label: string;
  passed: boolean;
}): JSX.Element {
  return (
    <div className={passed ? "learning-gate passed" : "learning-gate"}>
      <span>{passed ? "✓" : "○"}</span>
      <b>{label}</b>
    </div>
  );
}

function Comparison({
  slowMs,
  fastMs,
}: {
  slowMs: number;
  fastMs: number;
}): JSX.Element {
  const maximum = Math.max(slowMs, fastMs, 1);
  return (
    <DemoCard title="Measured path comparison" code="RUNTIME RESULT">
      <div className="comparison-bars">
        <div>
          <span>Slow Path</span>
          <i style={{ width: `${Math.max(3, (slowMs / maximum) * 100)}%` }} />
          <b>{formatDuration(slowMs)}</b>
        </div>
        <div className="fast">
          <span>Fast Path</span>
          <i style={{ width: `${Math.max(3, (fastMs / maximum) * 100)}%` }} />
          <b>{formatDuration(fastMs)}</b>
        </div>
      </div>
      <p className="demo-callout">
        Times are measured from observed session boundaries; no benchmark values
        are fabricated.
      </p>
      <p className="space-instruction">SPACE · SHOW SLIDE 3</p>
    </DemoCard>
  );
}

function stageTitle(stage: DemoDirectorState["stage"]): string {
  return (
    (
      {
        "mcp-link": "MCP connection proof",
        "slow-approval": "Signed launch gate",
        "slow-live": "Slow Path live",
        learning: "Learning and promotion proof",
        "fast-ready": "Fast Path handoff",
        "fast-live": "Fast Path live",
        comparison: "Slow vs Fast",
        game: "Action-game proof",
      } as Partial<Record<DemoDirectorState["stage"], string>>
    )[stage] ?? stage
  );
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Demo Director action failed.";
}
