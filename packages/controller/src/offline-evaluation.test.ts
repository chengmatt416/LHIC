import { describe, expect, it } from "vitest";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";

import {
  assertOfflineTarget,
  deriveOfflinePracticeTasks,
  OfflineEvaluationWorker,
} from "./offline-evaluation.js";

describe("offline candidate evaluation", () => {
  it("rejects production-like targets and requires deterministic evidence", async () => {
    expect(() =>
      assertOfflineTarget({
        candidateName: "candidate",
        environment: "local_fixture",
        targetUrl: "https://app.example.com",
        evaluationId: "invalid-local-target",
        uiFingerprint: "f".repeat(64),
        verifierVersion: "lhic-verifier-v1",
        verify: async () => ({ success: true, evidence: ["ignored"] }),
      }),
    ).toThrow("loopback");
    expect(() =>
      assertOfflineTarget({
        candidateName: "candidate",
        environment: "registered_test_account",
        targetUrl: "https://sandbox.example.test",
        evaluationId: "missing-account",
        uiFingerprint: "f".repeat(64),
        verifierVersion: "lhic-verifier-v1",
        allowlistedOrigins: ["https://sandbox.example.test"],
        verify: async () => ({ success: true, evidence: ["ignored"] }),
      }),
    ).toThrow("account identifier");

    const database = createMemoryDatabase();
    try {
      const store = new SkillStore(database);
      const evidence = { success: true, evidence: ["verified"] };
      for (const [index, taskId] of ["one", "two", "three"].entries()) {
        store.recordCandidateSuccess("candidate", {}, evidence, taskId, {
          source: "slow_path",
          environment: "production",
          origin: "https://docs.example.test",
          uiFingerprint: "a".repeat(64),
          traceSha256: String.fromCharCode(98 + index).repeat(64),
          verifierVersion: "lhic-verifier-v1",
        });
      }
      const worker = new OfflineEvaluationWorker(store);
      await expect(
        worker.evaluateCandidate({
          candidateName: "candidate",
          environment: "local_fixture",
          targetUrl: "http://localhost:4173/fixture",
          evaluationId: "holdout-failure",
          uiFingerprint: "f".repeat(64),
          verifierVersion: "lhic-verifier-v1",
          verify: async () => ({ success: false, evidence: [] }),
        }),
      ).resolves.toMatchObject({ promotionEligible: false });
      await expect(
        worker.evaluateCandidate({
          candidateName: "candidate",
          environment: "local_fixture",
          targetUrl: "http://localhost:4173/fixture",
          evaluationId: "holdout-success",
          uiFingerprint: "f".repeat(64),
          verifierVersion: "lhic-verifier-v1",
          verify: async () => evidence,
        }),
      ).resolves.toMatchObject({ promotionEligible: true });
      expect(store.get("candidate")).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it("generates credential-free practice tasks and validates registered accounts", () => {
    expect(
      deriveOfflinePracticeTasks([
        { signature: "selector_not_found", occurrences: 2 },
        {
          signature: "download_timeout",
          occurrences: 3,
          recommendation: "Retry in the local fixture.",
        },
      ]),
    ).toEqual([
      {
        id: "practice-1-download_timeout",
        environment: "local_fixture",
        goal: "Retry in the local fixture.",
        requiresCredentials: false,
      },
      {
        id: "practice-2-selector_not_found",
        environment: "local_fixture",
        goal: "Reproduce and verify selector_not_found.",
        requiresCredentials: false,
      },
    ]);
    expect(() =>
      assertOfflineTarget(
        {
          candidateName: "candidate",
          environment: "registered_test_account",
          targetUrl: "https://sandbox.example.test",
          evaluationId: "unregistered-account",
          uiFingerprint: "f".repeat(64),
          verifierVersion: "lhic-verifier-v1",
          allowlistedOrigins: ["https://sandbox.example.test"],
          registeredTestAccountId: "qa-account",
          verify: async () => ({ success: true, evidence: ["ignored"] }),
        },
        { has: () => false },
      ),
    ).toThrow("not registered");
  });
});
