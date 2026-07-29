"use client";

import React, { useEffect, useRef } from "react";

type ConnectionSource = "sse" | "rest" | "github" | "disconnected";

interface LogTerminalProps {
  logs: string[];
  lastUpdated: string;
  connectionSource: ConnectionSource;
}

const sourceConfig: Record<ConnectionSource, { label: string; color: string; dotColor: string }> = {
  sse: { label: "LIVE STREAM (SSE)", color: "var(--accent-emerald)", dotColor: "#10b981" },
  rest: { label: "VM REST POLL", color: "var(--accent-cyan)", dotColor: "#06b6d4" },
  github: { label: "GITHUB FALLBACK", color: "var(--accent-amber)", dotColor: "#f59e0b" },
  disconnected: { label: "DISCONNECTED", color: "var(--text-muted)", dotColor: "#64748b" },
};

export const LogTerminal: React.FC<LogTerminalProps> = ({ logs, lastUpdated, connectionSource }) => {
  const bodyRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  useEffect(() => {
    if (isAtBottomRef.current && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    if (!bodyRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = bodyRef.current;
    isAtBottomRef.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  const source = sourceConfig[connectionSource];

  return (
    <div className="terminal-window" style={{ marginBottom: "28px" }}>
      <div className="terminal-header">
        <div className="terminal-dot dot-red" />
        <div className="terminal-dot dot-yellow" />
        <div className="terminal-dot dot-green" />
        <span
          style={{
            fontSize: "12px",
            color: "var(--text-muted)",
            marginLeft: "12px",
            fontWeight: 500,
          }}
        >
          lhic-training.service
        </span>
        <span
          style={{
            fontSize: "11px",
            color: source.color,
            marginLeft: "12px",
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          <span
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              backgroundColor: source.dotColor,
              display: "inline-block",
              animation: connectionSource === "sse" ? "pulse 1.5s infinite" : "none",
            }}
          />
          {source.label}
        </span>
        <span
          style={{
            fontSize: "11px",
            color: "var(--text-muted)",
            marginLeft: "auto",
            marginRight: "12px",
          }}
        >
          {logs.length} lines • {new Date(lastUpdated).toLocaleTimeString()}
        </span>
      </div>
      <div
        className="terminal-body"
        ref={bodyRef}
        onScroll={handleScroll}
        style={{ maxHeight: "400px", overflowY: "auto" }}
      >
        {logs.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
            {connectionSource === "disconnected"
              ? "No connection — click Reconnect to try again"
              : "Waiting for live log stream..."}
          </div>
        ) : (
          logs.map((line, idx) => {
            let color = "#cbd5e1";
            if (line.includes("PyTorch Fit Result")) color = "#10b981";
            else if (line.includes("Resilience Result")) color = "#06b6d4";
            else if (line.includes("Public Web Skill")) color = "#a78bfa";
            else if (line.includes("Step")) color = "#f59e0b";
            else if (line.includes("Cycle #")) color = "#38bdf8";
            else if (line.includes("failed") || line.includes("Error")) color = "#f87171";
            else if (line.includes("GitHub Sync")) color = "#818cf8";

            return (
              <div key={idx} style={{ color, marginBottom: "2px", fontSize: "13px" }}>
                {line}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
