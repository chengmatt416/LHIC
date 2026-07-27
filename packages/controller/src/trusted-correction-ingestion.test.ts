import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { InMemoryHumanIntentCorrectionReplayStore } from "./correction-replay-store.js";
import { HumanIntentLearnLoop } from "./human-intent-learnloop.js";
import {
  TrustedHumanIntentCorrectionIngestion,
  createSignedHumanIntentCorrectionApproval,
  signHumanIntentCorrectionApproval,
  type HumanIntentCorrectionBinding,
} from "./trusted-correction-ingestion.js";

const issuedAt = new Date("2026-07-27T00:00:00.000Z");
const ingestionTime = new Date("2026-07-27T00:00:01.000Z");
const keyPair = generateKeyPairSync("ed25519");

const ambiguousState: NormalizedUIState = {
  surface: "browser",
  url: "https://example.test/workspace",
  objects: [
    { id: "email", role: "textbox", label: "Email", source: "dom" },
    {
      id: "password",
      role: "textbox",
      label: "Password",
      source: "dom",
    },
    {
      id: "search",
      role: "searchbox",
      label: "Search projects",
      source: "dom",
    },
  ],
  signals: {},
  capturedAt: "2026-07-27T00:00:00.000Z",
};

const searchIntent: UserIntent = {
  goal: "Search for the release project",
  constraints: { query: "release" },
  riskLevel: "low",
  requiresConfirmation: false,
  missingInformation: [],
};

describe("TrustedHumanIntentCorrectionIngestion", () => {
  it("accepts one exactly bound signed correction without storing raw identity data", () => {
    const binding = correctionBinding("private-task-1");
    const approval = signedApproval(binding, "person@example.com");
    const serializedClaim = JSON.stringify(approval.claim);
    expect(serializedClaim).not.toContain("private-task-1");
    expect(serializedClaim).not.toContain("person@example.com");
    expect(serializedClaim).not.toContain(searchIntent.goal);
    expect(serializedClaim).not.toContain("Search projects");

    const loop = new HumanIntentLearnLoop();
    const gate = ingestionGate();
    const rule = gate.ingest(loop, binding, approval);

    expect(rule).toMatchObject({
      fromStage: "login",
      toStage: "search",
      status: "candidate",
    });
    expect(rule.trainingTaskHashes).toEqual([hashState("private-task-1")]);
    expect(gate.consumedApprovalCount()).toBe(1);
  });

  it("rejects approval ID replay", () => {
    const binding = correctionBinding("replay-task");
    const approval = signedApproval(binding);
    const gate = ingestionGate();
    gate.ingest(new HumanIntentLearnLoop(), binding, approval);

    expect(() =>
      gate.ingest(new HumanIntentLearnLoop(), binding, approval),
    ).toThrow("approval replay");
  });

  it("rejects nonce reuse even under a newly signed approval ID", () => {
    const nonce = "a".repeat(64);
    const firstBinding = correctionBinding("nonce-task-1");
    const secondBinding = correctionBinding("nonce-task-2");
    const first = signedApproval(firstBinding, "reviewer-a", { nonce });
    const second = signedApproval(secondBinding, "reviewer-a", { nonce });
    const gate = ingestionGate();
    gate.ingest(new HumanIntentLearnLoop(), firstBinding, first);

    expect(() =>
      gate.ingest(new HumanIntentLearnLoop(), secondBinding, second),
    ).toThrow("nonce replay");
  });

  it("rejects cross-task and stale-UI substitution", () => {
    const binding = correctionBinding("bound-task");
    const approval = signedApproval(binding);
    const gate = ingestionGate();

    expect(() =>
      gate.ingest(
        new HumanIntentLearnLoop(),
        { ...binding, taskId: "other-task" },
        approval,
      ),
    ).toThrow("taskIdSha256");

    expect(() =>
      gate.ingest(
        new HumanIntentLearnLoop(),
        {
          ...binding,
          uiState: {
            ...binding.uiState,
            objects: [
              ...binding.uiState.objects,
              {
                id: "unexpected",
                role: "button",
                label: "Changed UI",
                source: "dom",
              },
            ],
          },
        },
        approval,
      ),
    ).toThrow("uiFingerprint");
  });

  it("rejects trace, verifier-version, and verifier-result substitution", () => {
    const binding = correctionBinding("evidence-task");
    const approval = signedApproval(binding);
    const gate = ingestionGate();

    expect(() =>
      gate.ingest(
        new HumanIntentLearnLoop(),
        { ...binding, traceSha256: hashState("different-trace") },
        approval,
      ),
    ).toThrow("traceSha256");
    expect(() =>
      gate.ingest(
        new HumanIntentLearnLoop(),
        { ...binding, verifierVersion: "other-verifier-v2" },
        approval,
      ),
    ).toThrow("verifierVersion");
    expect(() =>
      gate.ingest(
        new HumanIntentLearnLoop(),
        {
          ...binding,
          verification: {
            success: true,
            evidence: ["Different verifier evidence."],
          },
        },
        approval,
      ),
    ).toThrow("verificationSha256");
  });

  it("rejects revoked, expired, and incorrectly signed approvals", () => {
    const binding = correctionBinding("revocation-task");
    const approval = signedApproval(binding);
    const revoked = new Set([approval.claim.approvalId]);
    expect(() =>
      ingestionGate({ isApprovalRevoked: (id) => revoked.has(id) }).ingest(
        new HumanIntentLearnLoop(),
        binding,
        approval,
      ),
    ).toThrow("revoked");

    const expired = signedApproval(binding, "reviewer", { expiresInMs: 500 });
    expect(() =>
      ingestionGate({ now: () => ingestionTime }).ingest(
        new HumanIntentLearnLoop(),
        binding,
        expired,
      ),
    ).toThrow("expired");

    const otherKeyPair = generateKeyPairSync("ed25519");
    const wrongSignature = signHumanIntentCorrectionApproval(
      approval.claim,
      otherKeyPair.privateKey,
    );
    expect(() =>
      ingestionGate().ingest(
        new HumanIntentLearnLoop(),
        binding,
        wrongSignature,
      ),
    ).toThrow("signature verification failed");
  });

  it("never trains from a post-execution verifier failure", () => {
    const binding = correctionBinding("failed-outcome-task");
    const approval = signedApproval(binding);
    const failedBinding: HumanIntentCorrectionBinding = {
      ...binding,
      verification: {
        success: false,
        evidence: ["Expected result was absent."],
        error: "verification failed",
      },
    };
    const loop = new HumanIntentLearnLoop();

    expect(() => ingestionGate().ingest(loop, failedBinding, approval)).toThrow(
      "successful post-execution verifier evidence",
    );
    expect(loop.listRules()).toEqual([]);
  });

  it("consumes a valid bound approval before a downstream LearnLoop rejection", () => {
    const binding: HumanIntentCorrectionBinding = {
      ...correctionBinding("downstream-rejection"),
      predictedStage: "search",
      correctedStage: "download",
    };
    const approval = signedApproval(binding);
    const gate = ingestionGate();

    expect(() =>
      gate.ingest(new HumanIntentLearnLoop(), binding, approval),
    ).toThrow("does not match the current base prediction");
    expect(() =>
      gate.ingest(new HumanIntentLearnLoop(), binding, approval),
    ).toThrow("approval replay");
  });

  it("fails closed when the revocation authority is unavailable", () => {
    const binding = correctionBinding("revocation-error");
    const approval = signedApproval(binding);
    expect(() =>
      ingestionGate({
        isApprovalRevoked: () => {
          throw new Error("store unavailable");
        },
      }).ingest(new HumanIntentLearnLoop(), binding, approval),
    ).toThrow("revocation status could not be verified");
  });
});

function correctionBinding(taskId: string): HumanIntentCorrectionBinding {
  return {
    taskId,
    traceSha256: hashState({ taskId, kind: "trace" }),
    verifierVersion: "test-verifier-v1",
    split: "training",
    intent: searchIntent,
    uiState: ambiguousState,
    predictedStage: "login",
    correctedStage: "search",
    verification: { success: true, evidence: ["Search result verified."] },
  };
}

function signedApproval(
  binding: HumanIntentCorrectionBinding,
  approvedBy = "trusted-reviewer",
  options: { nonce?: string; expiresInMs?: number } = {},
) {
  return createSignedHumanIntentCorrectionApproval(
    binding,
    approvedBy,
    keyPair.privateKey,
    {
      now: issuedAt,
      ...(options.nonce ? { nonce: options.nonce } : {}),
      ...(options.expiresInMs ? { expiresInMs: options.expiresInMs } : {}),
    },
  );
}

function ingestionGate(
  overrides: {
    now?: () => Date;
    isApprovalRevoked?: (approvalId: string) => boolean;
  } = {},
): TrustedHumanIntentCorrectionIngestion {
  const now = overrides.now ?? (() => ingestionTime);
  return new TrustedHumanIntentCorrectionIngestion({
    publicKey: keyPair.publicKey,
    replayStore: new InMemoryHumanIntentCorrectionReplayStore({ now }),
    now,
    ...(overrides.isApprovalRevoked
      ? { isApprovalRevoked: overrides.isApprovalRevoked }
      : {}),
  });
}
