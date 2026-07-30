"use client";

import React, { useState } from "react";
import { sha256Hash, encryptSecret, sanitizeInput } from "../security/zero-trust";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentPin: string;
  onSavePin: (newPin: string, newPinHash: string) => void;
  currentPat: string;
  onSavePat: (encryptedPatHex: string, ivHex: string) => void;
}

type Tab = "security" | "pat";

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  currentPin,
  onSavePin,
  currentPat,
  onSavePat,
}) => {
  const [tab, setTab] = useState<Tab>("security");

  // Change password state
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [isChangingPin, setIsChangingPin] = useState(false);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  // PAT state
  const [pat, setPat] = useState(currentPat);
  const [isSavingPat, setIsSavingPat] = useState(false);
  const [patMessage, setPatMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleChangePin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError(null);
    setPinMessage(null);

    const cleanOld = sanitizeInput(oldPin, 32);
    const cleanNew = sanitizeInput(newPin, 32);
    const cleanConfirm = sanitizeInput(confirmPin, 32);

    if (!cleanOld) {
      setPinError("Current PIN is required.");
      return;
    }
    if (!cleanNew) {
      setPinError("New PIN cannot be empty.");
      return;
    }
    if (cleanNew.length < 4) {
      setPinError("New PIN must be at least 4 characters.");
      return;
    }
    if (cleanNew === cleanOld) {
      setPinError("New PIN must be different from current PIN.");
      return;
    }
    if (cleanNew !== cleanConfirm) {
      setPinError("New PIN and confirmation do not match.");
      return;
    }

    setIsChangingPin(true);
    try {
      const oldHash = await sha256Hash(cleanOld);
      const newHash = await sha256Hash(cleanNew);

      const res = await fetch("/api/change-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPinHash: oldHash, newPinHash: newHash }),
      });

      const data = (await res.json()) as {
        success: boolean;
        error?: string;
        token?: string;
        message?: string;
      };

      if (data.success) {
        // Update local storage
        onSavePin(cleanNew, newHash);
        setPinMessage(data.message || "PIN changed successfully.");
        setOldPin("");
        setNewPin("");
        setConfirmPin("");
        setTimeout(() => {
          setPinMessage(null);
          onClose();
        }, 2000);
      } else {
        setPinError(data.error || "Failed to change PIN.");
      }
    } catch {
      setPinError("Network error — try again.");
    } finally {
      setIsChangingPin(false);
    }
  };

  const handleSavePat = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPat = pat.trim();

    setIsSavingPat(true);
    try {
      if (cleanPat.length > 0) {
        const pinHash = await sha256Hash(currentPin || "2026");
        const { ciphertext, iv } = await encryptSecret(cleanPat, pinHash);
        onSavePat(ciphertext, iv);
        setPatMessage("GitHub PAT encrypted and saved locally.");
      } else {
        localStorage.removeItem("lhic_github_pat_enc");
        setPatMessage("GitHub PAT removed.");
      }
      setTimeout(() => setPatMessage(null), 2000);
    } catch {
      setPatMessage("Encryption failed.");
    } finally {
      setIsSavingPat(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "12px 14px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.15)",
    backgroundColor: "rgba(15,23,42,0.85)",
    color: "#fff",
    fontSize: "14px",
    outline: "none",
    boxSizing: "border-box",
  };

  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "13px",
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: "6px",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: "rgba(0, 0, 0, 0.8)",
        backdropFilter: "blur(8px)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        className="glass-panel"
        style={{
          width: "100%",
          maxWidth: "520px",
          padding: "32px",
          position: "relative",
          boxShadow: "0 25px 60px rgba(0,0,0,0.7)",
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <button
          onClick={onClose}
          style={{
            position: "absolute",
            top: "20px",
            right: "20px",
            background: "none",
            border: "none",
            color: "var(--text-secondary)",
            fontSize: "20px",
            cursor: "pointer",
          }}
        >
          &#10005;
        </button>

        <h2 style={{ fontSize: "22px", fontWeight: 800, marginBottom: "8px" }}>
          Zero-Trust Settings
        </h2>
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "20px" }}>
          Change PIN server-side or manage GitHub PAT encryption.
        </p>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: "4px", marginBottom: "24px" }}>
          {([
            ["security", "Change PIN"],
            ["pat", "GitHub PAT"],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                flex: 1,
                padding: "10px",
                borderRadius: "8px",
                border: "1px solid",
                borderColor: tab === key ? "rgba(6,182,212,0.5)" : "rgba(255,255,255,0.1)",
                backgroundColor: tab === key ? "rgba(6,182,212,0.12)" : "transparent",
                color: tab === key ? "var(--accent-cyan)" : "var(--text-secondary)",
                fontWeight: 600,
                fontSize: "13px",
                cursor: "pointer",
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Change PIN tab */}
        {tab === "security" && (
          <form onSubmit={handleChangePin}>
            {pinError && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "8px",
                  backgroundColor: "rgba(248,113,113,0.15)",
                  border: "1px solid rgba(248,113,113,0.3)",
                  color: "#f87171",
                  fontSize: "13px",
                  marginBottom: "16px",
                }}
              >
                {pinError}
              </div>
            )}
            {pinMessage && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "8px",
                  backgroundColor: "rgba(16,185,129,0.15)",
                  border: "1px solid rgba(16,185,129,0.3)",
                  color: "var(--accent-emerald)",
                  fontSize: "13px",
                  marginBottom: "16px",
                }}
              >
                {pinMessage}
              </div>
            )}

            <div style={{ marginBottom: "16px" }}>
              <label style={labelStyle}>Current PIN</label>
              <input
                type="password"
                value={oldPin}
                onChange={(e) => setOldPin(e.target.value)}
                placeholder="Enter current PIN"
                autoFocus
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: "16px" }}>
              <label style={labelStyle}>New PIN</label>
              <input
                type="password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                placeholder="Min 4 characters"
                style={inputStyle}
              />
            </div>

            <div style={{ marginBottom: "20px" }}>
              <label style={labelStyle}>Confirm New PIN</label>
              <input
                type="password"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
                placeholder="Re-enter new PIN"
                style={inputStyle}
              />
            </div>

            <p style={{ fontSize: "11px", color: "var(--text-muted)", marginBottom: "16px" }}>
              Server-side: old PIN hash verified against stored hash. New PIN stored via Cloudflare KV.
              Client-side: SHA-256 hashed before transmission, never sent in plaintext.
            </p>

            <div style={{ display: "flex", gap: "12px" }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: "12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(255,255,255,0.15)",
                  backgroundColor: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "14px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isChangingPin}
                style={{
                  flex: 1,
                  padding: "12px",
                  borderRadius: "8px",
                  border: "none",
                  background: isChangingPin
                    ? "rgba(255,255,255,0.1)"
                    : "linear-gradient(135deg, var(--accent-cyan), var(--accent-emerald))",
                  color: "#000",
                  fontWeight: 700,
                  fontSize: "14px",
                  cursor: isChangingPin ? "wait" : "pointer",
                }}
              >
                {isChangingPin ? "Changing..." : "Change PIN"}
              </button>
            </div>
          </form>
        )}

        {/* PAT tab */}
        {tab === "pat" && (
          <form onSubmit={handleSavePat}>
            {patMessage && (
              <div
                style={{
                  padding: "10px 12px",
                  borderRadius: "8px",
                  backgroundColor: "rgba(16,185,129,0.15)",
                  border: "1px solid rgba(16,185,129,0.3)",
                  color: "var(--accent-emerald)",
                  fontSize: "13px",
                  marginBottom: "16px",
                }}
              >
                {patMessage}
              </div>
            )}

            <div style={{ marginBottom: "20px" }}>
              <label style={labelStyle}>GitHub Personal Access Token</label>
              <input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="github_pat_11AAAAAA..."
                style={inputStyle}
              />
              <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px" }}>
                Encrypted client-side with AES-256-GCM using your PIN as key. Never sent to server.
              </p>
            </div>

            <div style={{ display: "flex", gap: "12px" }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  flex: 1,
                  padding: "12px",
                  borderRadius: "8px",
                  border: "1px solid rgba(255,255,255,0.15)",
                  backgroundColor: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: "14px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSavingPat}
                style={{
                  flex: 1,
                  padding: "12px",
                  borderRadius: "8px",
                  border: "none",
                  background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-emerald))",
                  color: "#000",
                  fontWeight: 700,
                  fontSize: "14px",
                  cursor: isSavingPat ? "wait" : "pointer",
                }}
              >
                {isSavingPat ? "Encrypting..." : "Save PAT"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};
