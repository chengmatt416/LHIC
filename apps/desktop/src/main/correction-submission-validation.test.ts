import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createSignedHumanIntentCorrectionApproval,
  type HumanIntentCorrectionBinding,
} from "@lhic/controller";
import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { validateHumanIntentCorrectionSubmission } from "./correction-submission-validation.js";

describe("Human Intent correction IPC validation", () => {
  it("canonicalizes a valid signed submission", () => {
    const submission = validSubmission();
    expect(validateHumanIntentCorrectionSubmission(submission)).toEqual(
      submission,
    );
  });

  it("rejects unexpected top-level fields", () => {
    expect(() =>
      validateHumanIntentCorrectionSubmission({
        ...validSubmission(),
        bypass: true,
      }),
    ).toThrow("unexpected fields");
  });

  it("rejects oversized and circular input before controller hashing", () => {
    const oversized = validSubmission();
    oversized.binding.uiState.signals = { padding: "x".repeat(600_000) };
    expect(() => validateHumanIntentCorrectionSubmission(oversized)).toThrow(
      "too large",
    );
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => validateHumanIntentCorrectionSubmission(circular)).toThrow(
      "not JSON-safe",
    );
  });

  it("rejects deeply nested input before recursive state hashing", () => {
    const submission = validSubmission();
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 40; depth += 1) {
      nested = { next: nested };
    }
    submission.binding.intent.constraints = { nested };
    expect(() => validateHumanIntentCorrectionSubmission(submission)).toThrow(
      "nested too deeply",
    );
  });

  it("rejects malformed intent and UI object fields", () => {
    const malformedIntent = validSubmission();
    malformedIntent.binding.intent.riskLevel = "critical" as never;
    expect(() =>
      validateHumanIntentCorrectionSubmission(malformedIntent),
    ).toThrow("risk level");

    const malformedObject = validSubmission();
    malformedObject.binding.uiState.objects[0] = {
      ...malformedObject.binding.uiState.objects[0],
      id: 42,
    } as never;
    expect(() =>
      validateHumanIntentCorrectionSubmission(malformedObject),
    ).toThrow("object ID");
  });

  it("rejects malformed verifier evidence", () => {
    const submission = validSubmission();
    submission.binding.verification = { success: true, evidence: [] };
    expect(() => validateHumanIntentCorrectionSubmission(submission)).toThrow(
      "verifier evidence",
    );
  });
});

function validSubmission() {
  const keyPair = generateKeyPairSync("ed25519");
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
        id: "search",
        role: "searchbox",
        label: "Search",
        source: "dom",
      },
    ],
    signals: {},
    capturedAt,
  };
  const binding: HumanIntentCorrectionBinding = {
    taskId: "ipc-correction-task",
    traceSha256: hashState({ capturedAt }),
    verifierVersion: "desktop-verifier-v1",
    split: "training",
    intent,
    uiState,
    predictedStage: "login",
    correctedStage: "search",
    verification: { success: true, evidence: ["Verified."] },
  };
  return {
    binding,
    approval: createSignedHumanIntentCorrectionApproval(
      binding,
      "external-authority",
      keyPair.privateKey,
      { now: new Date(), expiresInMs: 60_000 },
    ),
  };
}
