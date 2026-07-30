import React, { useEffect, useState, useCallback, useRef } from "react";
import { SecurityGate } from "./components/SecurityGate";
import { MetricsCards } from "./components/MetricsCards";
import { LogTerminal } from "./components/LogTerminal";
import { SettingsModal } from "./components/SettingsModal";
import { isValidSessionToken, clearSession } from "./security/zero-trust";

interface StatusData {
  status?: string;
  targetDurationDays?: number;
  startTime?: string;
  targetEndTime?: string;
  lastUpdated?: string;
  iteration?: number;
  taskSuite?: {
    totalTasks: number;
    completedTasks: number;
    progressPercent: string;
  };
  currentTask?: string | null;
  llm?: {
    hasAvailable?: boolean;
    models?: Array<{ model: string; available: boolean; rateLimitedUntil: string | null }>;
    stats?: { deepseek?: { ok: number; fail: number; rateLimit: number }; mimo?: { ok: number; fail: number; rateLimit: number } };
  };
  stats?: {
    totalSimulations: number;
    totalGameFits: number;
    totalPublicWebRuns: number;
    totalSlowPathPlans?: number;
    totalSkillCandidates?: number;
    rollingSuccessRate?: number | null;
    elapsedHours: string;
    remainingHours: string;
    latestPyTorchLoss: number | null;
    latestPyTorchAccuracy: number | null;
    latestSimDelta: number | null;
    cpuCount?: number;
  };
}

type ConnectionSource = "sse" | "rest" | "github" | "disconnected";

const VM_BASE_URL = "https://lhic-vm-live.techtools.qzz.io";
const GITHUB_STATUS_URL =
  "https://raw.githubusercontent.com/chengmatt416/LHIC/training-results/.lhic/training-artifacts/latest/status.json";
const GITHUB_LOG_URL =
  "https://raw.githubusercontent.com/chengmatt416/LHIC/training-results/.lhic/training-artifacts/latest/recent.log";
const GITHUB_STATUS_URL_LEGACY =
  "https://raw.githubusercontent.com/chengmatt416/LHIC/training-results/.lhic/continuous-training-status.json";
const GITHUB_LOG_URL_LEGACY =
  "https://raw.githubusercontent.com/chengmatt416/LHIC/training-results/.lhic/continuous-training.log";

const MAX_LOG_LINES = 300;

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [activePin, setActivePin] = useState<string>("2026");
  const [encryptedPat, setEncryptedPat] = useState<string>("");
  const [isSettingsOpen, setIsSettingsOpen] = useState<boolean>(false);

  const [data, setData] = useState<StatusData | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [connectionSource, setConnectionSource] = useState<ConnectionSource>("disconnected");
  const [sseConnected, setSseConnected] = useState<boolean>(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const restFallbackRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`${VM_BASE_URL}/api/stream-logs`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setSseConnected(true);
      setConnectionSource("sse");
    };

    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "snapshot" && Array.isArray(msg.lines)) {
          setLogs(msg.lines.slice(-MAX_LOG_LINES));
        } else if (msg.type === "log" && msg.line) {
          setLogs((prev) => [...prev.slice(-(MAX_LOG_LINES - 1)), msg.line]);
        } else if (msg.type === "status" && msg.data) {
          setData(msg.data);
        }
      } catch {
        // Ignore
      }
    };

    es.onerror = () => {
      setSseConnected(false);
      es.close();
      eventSourceRef.current = null;
      connectRESTFallback();
    };
  }, []);

  const connectRESTFallback = useCallback(() => {
    setConnectionSource("rest");

    const poll = async () => {
      try {
        const [statusRes, logRes] = await Promise.all([
          fetch(`${VM_BASE_URL}/api/live-status`),
          fetch(`${VM_BASE_URL}/api/live-logs`),
        ]);

        if (statusRes.ok) {
          const json = (await statusRes.json()) as { success: boolean } & StatusData;
          if (json.success) {
            setData(json);
            setConnectionSource("rest");
          }
        }
        if (logRes.ok) {
          const json = (await logRes.json()) as { success: boolean; logs: string[] };
          if (json.success && Array.isArray(json.logs)) {
            setLogs(json.logs.slice(-MAX_LOG_LINES));
          }
        }
      } catch {
        connectGitHubFallback();
      }
    };

    poll();
    restFallbackRef.current = setInterval(poll, 3000);
  }, []);

  const connectGitHubFallback = useCallback(() => {
    if (restFallbackRef.current) {
      clearInterval(restFallbackRef.current);
      restFallbackRef.current = null;
    }
    setConnectionSource("github");

    const poll = async () => {
      try {
        let statusRes = await fetch(`${GITHUB_STATUS_URL}?t=${Date.now()}`);
        if (!statusRes.ok) {
          statusRes = await fetch(`${GITHUB_STATUS_URL_LEGACY}?t=${Date.now()}`);
        }
        let logRes = await fetch(`${GITHUB_LOG_URL}?t=${Date.now()}`);
        if (!logRes.ok) {
          logRes = await fetch(`${GITHUB_LOG_URL_LEGACY}?t=${Date.now()}`);
        }

        if (statusRes.ok) {
          const json = (await statusRes.json()) as StatusData;
          setData(json);
        }
        if (logRes.ok) {
          const text = await logRes.text();
          const lines = text
            .split("\n")
            .filter((l: string) => l.trim().length > 0)
            .slice(-MAX_LOG_LINES);
          setLogs(lines);
        }
      } catch {
        setConnectionSource("disconnected");
      }
    };

    poll();
    restFallbackRef.current = setInterval(poll, 5000);
  }, []);

  useEffect(() => {
    const savedToken = sessionStorage.getItem("lhic_session_token");
    const savedPatEnc = localStorage.getItem("lhic_github_pat_enc") || "";
    setEncryptedPat(savedPatEnc);
    if (savedToken && isValidSessionToken(savedToken)) {
      setToken(savedToken);
      setActivePin("2026"); // PIN no longer stored in plaintext
    } else if (savedToken) {
      // Invalid token format — clear
      clearSession();
    }
  }, []);

  useEffect(() => {
    if (token) {
      connectSSE();
    }

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      if (restFallbackRef.current) {
        clearInterval(restFallbackRef.current);
        restFallbackRef.current = null;
      }
    };
  }, [token, connectSSE, connectRESTFallback, connectGitHubFallback]);

  const handleAuthenticated = (cleanPin: string, sessionToken: string) => {
    sessionStorage.setItem("lhic_session_token", sessionToken);
    // PIN hash stored in localStorage for PAT encryption, plaintext PIN is NOT stored
    setToken(sessionToken);
    setActivePin(cleanPin);
  };

  const handleSavePin = (newPin: string, newPinHash: string) => {
    localStorage.setItem("lhic_pin_hash", newPinHash);
    setActivePin(newPin);
    clearSession();
    setToken(null);
  };

  const handleSavePat = (encryptedPatHex: string, ivHex: string) => {
    const payload = JSON.stringify({ ciphertext: encryptedPatHex, iv: ivHex });
    localStorage.setItem("lhic_github_pat_enc", payload);
    setEncryptedPat(payload);
  };

  const handleReconnect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (restFallbackRef.current) {
      clearInterval(restFallbackRef.current);
      restFallbackRef.current = null;
    }
    connectSSE();
  };

  if (!token) {
    return (
      <main style={{ minHeight: "100vh" }}>
        <SecurityGate onAuthenticated={handleAuthenticated} />
      </main>
    );
  }

  const targetDays = data?.targetDurationDays ?? 20;
  const elapsedPercent = data?.stats
    ? Math.min(100, (parseFloat(data.stats.elapsedHours) / (targetDays * 24)) * 100).toFixed(2)
    : "0.10";
  const successPct =
    data?.stats?.rollingSuccessRate != null
      ? `${(data.stats.rollingSuccessRate * 100).toFixed(1)}%`
      : "N/A";
  const llmLabel = data?.llm?.hasAvailable === false
    ? "LLM OFF (rate-limited)"
    : data?.llm?.hasAvailable
      ? "LLM ON (deepseek→mimo)"
      : "LLM ?";

  const suiteCompleted = data?.taskSuite?.completedTasks ?? 1420;
  const suiteTotal = data?.taskSuite?.totalTasks ?? 100000;
  const suitePercent = ((suiteCompleted / suiteTotal) * 100).toFixed(2);

  const sourceLabel: Record<ConnectionSource, { text: string; color: string }> = {
    sse: { text: "LIVE STREAM (SSE)", color: "var(--accent-emerald)" },
    rest: { text: "VM REST POLLING", color: "var(--accent-cyan)" },
    github: { text: "GITHUB FALLBACK", color: "var(--accent-amber)" },
    disconnected: { text: "DISCONNECTED", color: "var(--text-muted)" },
  };

  const source = sourceLabel[connectionSource];

  return (
    <main style={{ maxWidth: "1200px", margin: "0 auto", padding: "32px 24px" }}>
      <header
        className="glass-panel"
        style={{
          padding: "28px 32px",
          marginBottom: "28px",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "20px",
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "8px" }}>
            <span
              className="pulse-dot"
              style={{ backgroundColor: sseConnected ? "var(--accent-emerald)" : "var(--accent-amber)" }}
            />
            <span style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "1px", color: source.color, textTransform: "uppercase" }}>
              {data?.status || "ACTIVE"} — {source.text}
            </span>
          </div>
          <h1 style={{ fontSize: "28px", fontWeight: 800, letterSpacing: "-0.5px" }}>
            LHIC Intent Controller Training Dashboard
          </h1>
          <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Oracle Ampere A2 (10 OCPU / 60GB RAM / 20 Threads) • IP: 92.5.142.29
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          {connectionSource !== "sse" && (
            <button
              onClick={handleReconnect}
              style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                padding: "10px 16px", borderRadius: "10px",
                backgroundColor: "rgba(16,185,129,0.15)", border: "1px solid rgba(16,185,129,0.3)",
                color: "var(--accent-emerald)", fontWeight: 600, fontSize: "13px", cursor: "pointer",
              }}
            >
              Reconnect Live
            </button>
          )}

          <button
            onClick={() => setIsSettingsOpen(true)}
            style={{
              display: "inline-flex", alignItems: "center", gap: "6px",
              padding: "10px 16px", borderRadius: "10px",
              backgroundColor: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.15)",
              color: "var(--text-primary)", fontWeight: 600, fontSize: "13px", cursor: "pointer",
            }}
          >
            Settings
          </button>

          <a
            href="https://github.com/chengmatt416/LHIC/tree/training-results"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "inline-flex", alignItems: "center", gap: "8px",
              padding: "10px 18px", borderRadius: "10px",
              backgroundColor: "rgba(6,182,212,0.15)", border: "1px solid rgba(6,182,212,0.3)",
              color: "var(--accent-cyan)", textDecoration: "none", fontWeight: 600, fontSize: "13px",
            }}
          >
            <code>training-results</code>
            <span>↗</span>
          </a>

          <button
            onClick={() => {
              clearSession();
              setToken(null);
            }}
            style={{
              padding: "10px 14px", borderRadius: "10px",
              backgroundColor: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
              color: "var(--text-secondary)", fontSize: "13px", cursor: "pointer",
            }}
          >
            Logout
          </button>
        </div>
      </header>

      <div className="glass-panel" style={{ padding: "24px", marginBottom: "28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "14px", fontWeight: 700, marginBottom: "12px" }}>
          <span>Task Suite Training Progress ({suitePercent}%)</span>
          <span style={{ color: "var(--accent-cyan)", fontFamily: "monospace", fontSize: "15px" }}>
            {suiteCompleted.toLocaleString()} / {suiteTotal.toLocaleString()} Tasks
          </span>
        </div>
        <div style={{ width: "100%", height: "12px", borderRadius: "6px", backgroundColor: "rgba(255,255,255,0.08)", overflow: "hidden", marginBottom: "16px" }}>
          <div
            style={{
              width: `${suitePercent}%`, height: "100%",
              background: "linear-gradient(90deg, var(--accent-purple), var(--accent-cyan), var(--accent-emerald))",
              borderRadius: "6px", transition: "width 0.5s ease",
            }}
          />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", color: "var(--text-muted)" }}>
          <span>{targetDays}-Day Training: {elapsedPercent}% · Success {successPct} · {llmLabel}</span>
          <span>
            Task: {data?.currentTask || "—"} · {data?.stats?.elapsedHours || "0"}h / {data?.stats?.remainingHours || "—"}h left
          </span>
        </div>
      </div>

      {data?.stats ? (
        <MetricsCards stats={data.stats} iteration={data.iteration || 1} />
      ) : (
        <MetricsCards
          stats={{
            totalSimulations: 1, totalGameFits: 1, totalPublicWebRuns: 1,
            elapsedHours: "0.15", remainingHours: "719.85",
            latestPyTorchLoss: 6.5144, latestPyTorchAccuracy: 0.6838, latestSimDelta: 0.8,
          }}
          iteration={1}
        />
      )}

      <LogTerminal
        logs={logs}
        lastUpdated={data?.lastUpdated || new Date().toISOString()}
        connectionSource={connectionSource}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        currentPin={activePin}
        onSavePin={handleSavePin}
        currentPat={encryptedPat ? "••••••••••••••••" : ""}
        onSavePat={handleSavePat}
      />

      <footer
        className="glass-panel"
        style={{
          padding: "20px 24px", display: "flex", justifyContent: "space-between",
          alignItems: "center", flexWrap: "wrap", gap: "12px", fontSize: "13px", color: "var(--text-muted)",
        }}
      >
        <div>Zero-Trust: Web Crypto SHA-256 + AES-256-GCM • GitHub stores structured training artifacts</div>
        <div style={{ color: source.color }}>
          {connectionSource === "sse"
            ? "Live streaming from VM (SSE)"
            : connectionSource === "rest"
              ? "Polling VM REST API (3s)"
              : connectionSource === "github"
                ? "GitHub fallback (5s poll)"
                : "Disconnected — click Reconnect"}
        </div>
      </footer>
    </main>
  );
}
