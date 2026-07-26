import { generateKeyPairSync } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSignedHumanIntentCorrectionApproval,
  type HumanIntentCorrectionBinding,
} from "@lhic/controller";
import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { createDesktopHumanIntentCorrectionRuntime } from "./correction-ingestion-runtime.js";

const temporaryDirectories: string[] = [];
const keyPair = generateKeyPairSync("ed25519");
const publicKey = keyPair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop Human Intent correction runtime", () => {
  it("remains fail-closed when no correction authority is configured", () => {
    const runtime = createDesktopHumanIntentCorrectionRuntime(
      temporaryDirectory(),
      {},
    );
    expect(runtime.configured).toBe(false);
    const binding = correctionBinding();
    const approval = signedApproval(binding);
    expect(() => runtime.admission.ingestCorrection(binding, approval)).toThrow(
      "not configured",
    );
  });

  it("uses the same admission LearnLoop and rejects replay after restart", () => {
    const workspace = temporaryDirectory();
    const replayDirectory = join(workspace, "persistent-replay");
    const environment = {
      LHIC_CORRECTION_APPROVAL_PUBLIC_KEY: publicKey,
      LHIC_CORRECTION_REPLAY_DIRECTORY: replayDirectory,
    };
    const binding = correctionBinding();
    const approval = signedApproval(binding);
    const first = createDesktopHumanIntentCorrectionRuntime(
      workspace,
      environment,
    );
    expect(first.configured).toBe(true);
    expect(first.replayDirectory).toBe(replayDirectory);
    expect(first.admission.ingestCorrection(binding, approval).status).toBe(
      "candidate",
    );

    const restarted = createDesktopHumanIntentCorrectionRuntime(
      workspace,
      environment,
    );
    expect(() =>
      restarted.admission.ingestCorrection(binding, approval),
    ).toThrow("replay");
  });

  it("accepts a bounded regular public-key file", () => {
    const workspace = temporaryDirectory();
    const keyFile = join(workspace, "correction-public.pem");
    writeFileSync(keyFile, publicKey, { mode: 0o600 });
    const runtime = createDesktopHumanIntentCorrectionRuntime(workspace, {
      LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE: keyFile,
    });
    expect(runtime.configured).toBe(true);
  });

  it("rejects a public-key symlink", () => {
    if (process.platform === "win32") return;
    const workspace = temporaryDirectory();
    const keyFile = join(workspace, "correction-public.pem");
    const keyLink = join(workspace, "correction-public-link.pem");
    writeFileSync(keyFile, publicKey, { mode: 0o600 });
    symlinkSync(keyFile, keyLink);
    expect(() =>
      createDesktopHumanIntentCorrectionRuntime(workspace, {
        LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE: keyLink,
      }),
    ).toThrow("not a symlink");
  });

  it("rejects ambiguous, invalid, and relative configuration", () => {
    const workspace = temporaryDirectory();
    const keyFile = join(workspace, "correction-public.pem");
    writeFileSync(keyFile, publicKey, { mode: 0o600 });
    expect(() =>
      createDesktopHumanIntentCorrectionRuntime(workspace, {
        LHIC_CORRECTION_APPROVAL_PUBLIC_KEY: publicKey,
        LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE: keyFile,
      }),
    ).toThrow("only one");
    expect(() =>
      createDesktopHumanIntentCorrectionRuntime(workspace, {
        LHIC_CORRECTION_APPROVAL_PUBLIC_KEY: "not-a-key",
      }),
    ).toThrow("valid Ed25519");
    expect(() =>
      createDesktopHumanIntentCorrectionRuntime(workspace, {
        LHIC_CORRECTION_APPROVAL_PUBLIC_KEY: publicKey,
        LHIC_CORRECTION_REPLAY_DIRECTORY: "relative/replay",
      }),
    ).toThrow("absolute path");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lhic-correction-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function correctionBinding(): HumanIntentCorrectionBinding {
  const capturedAt = new Date().toISOString();
  const intent: UserIntent = {
    goal: "Search for release notes",
    constraints: {},
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
  const uiState: NormalizedUIState = {
    surface: "browser",
    url: "https://example.test/search",
    objects: [
      {
        id: "email",
        role: "textbox",
        label: "Email",
        source: "dom",
      },
      {
        id: "password",
        role: "textbox",
        label: "Password",
        source: "dom",
      },
      {
        id: "search",
        role: "searchbox",
        label: "Search",
        source: "dom",
      },
    ],
    signals: {},
    capturedAt,
  };
  return {
    taskId: "desktop-correction-task",
    traceSha256: hashState({ capturedAt, trace: "verified" }),
    verifierVersion: "desktop-verifier-v1",
    split: "training",
    intent,
    uiState,
    predictedStage: "login",
    correctedStage: "search",
    verification: {
      success: true,
      evidence: ["Search result was verified after execution."],
    },
  };
}

function signedApproval(binding: HumanIntentCorrectionBinding) {
  return createSignedHumanIntentCorrectionApproval(
    binding,
    "external-correction-authority",
    keyPair.privateKey,
    { now: new Date(), expiresInMs: 5 * 60_000 },
  );
}
