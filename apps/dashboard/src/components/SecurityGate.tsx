"use client";

import React, { useState } from "react";
import { sha256Hash } from "../security/zero-trust";

interface SecurityGateProps {
  onAuthenticated: (pin: string, token: string) => void;
}

export const SecurityGate: React.FC<SecurityGateProps> = ({ onAuthenticated }) => {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;

    setIsProcessing(true);
    setError(null);

    try {
      const pinHash = await sha256Hash(pin.trim());
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinHash }),
      });

      const data = (await res.json()) as { success: boolean; token?: string; error?: string };
      if (data.success && data.token) {
        onAuthenticated(pin.trim(), data.token);
      } else {
        setError(data.error || "Authentication failed");
      }
    } catch {
      setError("Network error — try again");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        padding: "20px",
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: "100%",
          maxWidth: "420px",
          padding: "40px 32px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "48px", marginBottom: "16px" }}>&#128274;</div>
        <h1 style={{ fontSize: "24px", fontWeight: 800, marginBottom: "8px" }}>
          LHIC Training Dashboard
        </h1>
        <p style={{ fontSize: "14px", color: "var(--text-secondary)", marginBottom: "28px" }}>
          Enter your security PIN to access the live training dashboard.
        </p>

        {error && (
          <div
            style={{
              padding: "12px",
              borderRadius: "8px",
              backgroundColor: "rgba(248,113,113,0.15)",
              border: "1px solid rgba(248,113,113,0.3)",
              color: "#f87171",
              fontSize: "13px",
              marginBottom: "20px",
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="Enter PIN"
            autoFocus
            style={{
              width: "100%",
              padding: "14px 16px",
              borderRadius: "10px",
              border: "1px solid rgba(255,255,255,0.15)",
              backgroundColor: "rgba(15,23,42,0.85)",
              color: "#fff",
              fontSize: "16px",
              textAlign: "center",
              letterSpacing: "4px",
              outline: "none",
              marginBottom: "16px",
            }}
          />
          <button
            type="submit"
            disabled={isProcessing}
            style={{
              width: "100%",
              padding: "14px",
              borderRadius: "10px",
              border: "none",
              background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-emerald))",
              color: "#000",
              fontWeight: 700,
              fontSize: "15px",
              cursor: isProcessing ? "wait" : "pointer",
            }}
          >
            {isProcessing ? "Verifying..." : "Access Dashboard"}
          </button>
        </form>

        <p style={{ fontSize: "11px", color: "var(--text-muted)", marginTop: "20px" }}>
          Zero-Trust: PIN hashed with SHA-256 before transmission
        </p>
      </div>
    </div>
  );
};
