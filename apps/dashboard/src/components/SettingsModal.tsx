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

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  currentPin,
  onSavePin,
  currentPat,
  onSavePat,
}) => {
  const [pin, setPin] = useState(currentPin);
  const [pat, setPat] = useState(currentPat);
  const [isProcessing, setIsProcessing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPin = sanitizeInput(pin, 32);
    const cleanPat = pat.trim();

    if (!cleanPin) {
      setMessage("Security PIN cannot be empty.");
      return;
    }

    setIsProcessing(true);
    try {
      const pinHash = await sha256Hash(cleanPin);
      onSavePin(cleanPin, pinHash);

      if (cleanPat.length > 0) {
        const { ciphertext, iv } = await encryptSecret(cleanPat, pinHash);
        onSavePat(ciphertext, iv);
      }

      setMessage("Settings saved with AES-256-GCM encryption.");
      setTimeout(() => {
        setMessage(null);
        onClose();
      }, 1500);
    } catch {
      setMessage("Encryption failed, please try again.");
    } finally {
      setIsProcessing(false);
    }
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
        <p style={{ fontSize: "13px", color: "var(--text-secondary)", marginBottom: "24px" }}>
          PIN stored with SHA-256 hashing; GitHub PAT encrypted with AES-256-GCM.
        </p>

        {message && (
          <div
            style={{
              padding: "12px",
              borderRadius: "8px",
              backgroundColor: "rgba(16,185,129,0.15)",
              border: "1px solid rgba(16,185,129,0.3)",
              color: "var(--accent-emerald)",
              fontSize: "13px",
              marginBottom: "20px",
            }}
          >
            {message}
          </div>
        )}

        <form onSubmit={handleSave}>
          <div style={{ marginBottom: "20px" }}>
            <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" }}>
              Security PIN (SHA-256)
            </label>
            <input
              type="text"
              value={pin}
              maxLength={32}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Default: 2026"
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.15)",
                backgroundColor: "rgba(15,23,42,0.85)",
                color: "#fff",
                fontSize: "14px",
                outline: "none",
              }}
            />
          </div>

          <div style={{ marginBottom: "24px" }}>
            <label style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "var(--text-primary)", marginBottom: "6px" }}>
              GitHub Personal Access Token (AES-256-GCM)
            </label>
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="github_pat_11AAAAAA..."
              style={{
                width: "100%",
                padding: "12px 14px",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.15)",
                backgroundColor: "rgba(15,23,42,0.85)",
                color: "#fff",
                fontSize: "14px",
                outline: "none",
              }}
            />
            <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "6px" }}>
              PAT encrypted client-side with AES-256-GCM, never transmitted in plaintext.
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
              disabled={isProcessing}
              style={{
                flex: 1,
                padding: "12px",
                borderRadius: "8px",
                border: "none",
                background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-emerald))",
                color: "#000",
                fontWeight: 700,
                fontSize: "14px",
                cursor: isProcessing ? "wait" : "pointer",
              }}
            >
              {isProcessing ? "Encrypting..." : "Save & Encrypt"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
