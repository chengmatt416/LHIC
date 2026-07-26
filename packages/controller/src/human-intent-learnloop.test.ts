import { describe, expect, it } from "vitest";

import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import { hashState } from "@lhic/trace";

import {
  HumanIntentLearnLoop,
  type CorrectionEvidenceSplit,
  type VerifiedIntentCorrection,
} from "./human-intent-learnloop.js";

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
  capturedAt: "2026-07-26T00:00:00.000Z",
};

const searchIntent: UserIntent = {
  goal: "Search for the release project",
  constraints: { query: "release" },
  riskLevel: "low",
  requiresConfirmation: false,
  missingInformation: [],
};

describe("HumanIntentLearnLoop", () => {
  it("keeps prediction primary and activates only after training plus validation", () => {
    const loop = new HumanIntentLearnLoop();
    const before = loop.decide("before-learning", searchIntent, ambiguousState);
    expect(before.basePrediction.predictedIntent).toBe("login");
    expect(before.prediction.predictedIntent).toBe("login");

    trainSearchRule(loop);
    expect(loop.listRules()[0]).toMatchObject({ status: "candidate" });
    loop.recordCorrection(
      correction("validation-1", "validation", ambiguousState),
    );

    const after = loop.decide("after-learning", searchIntent, ambiguousState);
    expect(after.basePrediction.predictedIntent).toBe("login");
    expect(after.prediction).toMatchObject({
      predictedIntent: "search",
      skillName: "search",
    });
    expect(after.admission).toBe("execute_fast");
    expect(after.appliedRuleIds).toHaveLength(1);
  });

  it("deduplicates evidence and refuses validation leakage", () => {
    const loop = new HumanIntentLearnLoop();
    const repeated = correction("same-task", "training", ambiguousState);
    loop.recordCorrection(repeated);
    loop.recordCorrection(repeated);
    loop.recordCorrection(repeated);
    expect(loop.listRules()[0]).toMatchObject({
      status: "candidate",
      trainingTaskHashes: [hashState("same-task")],
    });

    expect(() =>
      loop.recordCorrection(
        correction("same-ui", "validation", ambiguousState, {
          uiFingerprint: repeated.provenance.uiFingerprint,
        }),
      ),
    ).toThrow("independent from training");
  });

  it("refuses unconfirmed, unverified, and unsupported corrections", () => {
    const loop = new HumanIntentLearnLoop();
    expect(() =>
      loop.recordCorrection({
        ...correction("unconfirmed", "training", ambiguousState),
        confirmedByUser: false,
      }),
    ).toThrow("confirmed by the user");
    expect(() =>
      loop.recordCorrection({
        ...correction("unverified", "training", ambiguousState),
        verification: { success: false, evidence: [] },
      }),
    ).toThrow("verifier evidence");
    expect(() =>
      loop.recordCorrection({
        ...correction("unsupported", "training", ambiguousState),
        correctedStage: "unknown",
      }),
    ).toThrow("known deterministic LHIC stages");
  });

  it("detects a stable-intent prediction change before execution", () => {
    const loop = new HumanIntentLearnLoop();
    const initial = loop.decide("drift-session", searchIntent, ambiguousState);
    expect(initial.prediction.predictedIntent).toBe("login");
    trainAndValidateSearchRule(loop);

    const changed = loop.decide("drift-session", searchIntent, ambiguousState);
    expect(changed.prediction.predictedIntent).toBe("search");
    expect(changed.drift.detected).toBe(true);
    expect(changed.admission).toBe("require_confirmation");
    expect(changed.drift.reasons.join(" ")).toContain(
      "fingerprint stayed stable",
    );
  });

  it("quarantines conflicting corrections and fails closed", () => {
    const loop = new HumanIntentLearnLoop();
    trainAndValidateSearchRule(loop);
    loop.recordCorrection({
      ...correction("download-conflict", "training", ambiguousState),
      correctedStage: "download",
    });

    expect(
      loop.listRules().every((rule) => rule.status === "quarantined"),
    ).toBe(true);
    const decision = loop.decide(
      "conflict-session",
      searchIntent,
      ambiguousState,
    );
    expect(decision.prediction.predictedIntent).toBe("login");
    expect(decision.drift.detected).toBe(true);
    expect(decision.admission).toBe("require_confirmation");
  });

  it("does not apply a learned target absent from current UI candidates", () => {
    const loop = new HumanIntentLearnLoop();
    for (const id of ["download-1", "download-2", "download-3"]) {
      loop.recordCorrection({
        ...correction(id, "training", ambiguousState),
        correctedStage: "download",
      });
    }
    loop.recordCorrection({
      ...correction("download-validation", "validation", ambiguousState),
      correctedStage: "download",
    });

    const decision = loop.decide(
      "ineligible-target",
      searchIntent,
      ambiguousState,
    );
    expect(decision.classificationCandidates).not.toContain("download");
    expect(decision.appliedRuleIds).toEqual([]);
    expect(decision.prediction.predictedIntent).toBe("login");
  });

  it("never lowers risk or bypasses confirmation", () => {
    const loop = new HumanIntentLearnLoop();
    const riskyIntent: UserIntent = {
      ...searchIntent,
      riskLevel: "high",
      requiresConfirmation: true,
    };
    const riskyState = { ...ambiguousState, capturedAt: "2026-07-26T01:00:00Z" };
    for (const id of ["risk-1", "risk-2", "risk-3"]) {
      loop.recordCorrection(
        correction(id, "training", riskyState, { intent: riskyIntent }),
      );
    }
    loop.recordCorrection(
      correction("risk-validation", "validation", riskyState, {
        intent: riskyIntent,
      }),
    );

    const decision = loop.decide("risky-session", riskyIntent, riskyState);
    expect(decision.admission).toBe("require_confirmation");
    expect(decision.reason).toContain("cannot be lowered");
  });

  it("quarantines a learned rule after a verifier-backed failure", () => {
    const loop = new HumanIntentLearnLoop();
    const rule = trainAndValidateSearchRule(loop);
    const updated = loop.recordAppliedOutcome({
      ruleId: rule.id,
      taskId: "failed-execution",
      success: false,
      verification: {
        success: false,
        evidence: ["Expected result was absent."],
        error: "verification failed",
      },
    });
    expect(updated.status).toBe("quarantined");
    expect(updated.failureCount).toBe(1);
    expect(
      loop.decide("after-failure", searchIntent, ambiguousState).appliedRuleIds,
    ).toEqual([]);
  });

  it("signs snapshots, rejects tampering, and does not retain raw task IDs", () => {
    const loop = new HumanIntentLearnLoop();
    trainAndValidateSearchRule(loop);
    const key = "0123456789abcdef0123456789abcdef";
    const signed = loop.exportSignedSnapshot(key);
    const serialized = JSON.stringify(signed);
    expect(serialized).not.toContain("training-secret-1");

    const restored = new HumanIntentLearnLoop();
    restored.importSignedSnapshot(signed, key);
    expect(restored.listRules()).toHaveLength(1);

    const tampered = structuredClone(signed);
    tampered.snapshot.rules[0]!.toStage = "download";
    expect(() => restored.importSignedSnapshot(tampered, key)).toThrow(
      "integrity verification failed",
    );
  });

  it("supports explicit revocation without silently evicting active rules", () => {
    const loop = new HumanIntentLearnLoop({ maximumRules: 1 });
    const rule = trainAndValidateSearchRule(loop);
    expect(loop.revokeRule(rule.id)).toBe(true);
    expect(
      loop.decide("revoked", searchIntent, ambiguousState).prediction
        .predictedIntent,
    ).toBe("login");
  });
});

function trainSearchRule(loop: HumanIntentLearnLoop): void {
  for (const id of [
    "training-secret-1",
    "training-secret-2",
    "training-secret-3",
  ]) {
    loop.recordCorrection(correction(id, "training", ambiguousState));
  }
}

function trainAndValidateSearchRule(loop: HumanIntentLearnLoop) {
  trainSearchRule(loop);
  return loop.recordCorrection(
    correction("validation-secret", "validation", ambiguousState),
  );
}

function correction(
  taskId: string,
  split: CorrectionEvidenceSplit,
  state: NormalizedUIState,
  overrides: {
    intent?: UserIntent;
    uiFingerprint?: string;
  } = {},
): VerifiedIntentCorrection {
  return {
    provenance: {
      taskId,
      uiFingerprint:
        overrides.uiFingerprint ?? hashState({ taskId, split, kind: "ui" }),
      traceSha256: hashState({ taskId, split, kind: "trace" }),
      verifierVersion: "test-verifier-v1",
      split,
    },
    intent: overrides.intent ?? searchIntent,
    uiState: state,
    predictedStage: "login",
    correctedStage: "search",
    confirmedByUser: true,
    verification: { success: true, evidence: ["Search result verified."] },
  };
}
