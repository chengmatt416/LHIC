import { describe, expect, it } from "vitest";

import type { NormalizedUIState, UserIntent } from "@lhic/schema";

import { HumanIntentLearnLoop } from "./human-intent-learnloop.js";

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
  it("keeps prediction primary and uses verified corrections to improve accuracy", () => {
    const loop = new HumanIntentLearnLoop({ minimumEvidence: 2 });
    const before = loop.decide("before-learning", searchIntent, ambiguousState);
    expect(before.basePrediction.predictedIntent).toBe("login");
    expect(before.prediction.predictedIntent).toBe("login");

    for (const taskId of ["correction-1", "correction-2"]) {
      loop.recordCorrection({
        taskId,
        intent: searchIntent,
        uiState: ambiguousState,
        predictedStage: "login",
        correctedStage: "search",
        confirmedByUser: true,
        verification: { success: true, evidence: ["Search result verified."] },
      });
    }

    const after = loop.decide("after-learning", searchIntent, ambiguousState);
    expect(after.basePrediction.predictedIntent).toBe("login");
    expect(after.prediction).toMatchObject({
      predictedIntent: "search",
      skillName: "search",
    });
    expect(after.admission).toBe("execute_fast");
    expect(after.appliedRuleIds).toHaveLength(1);
  });

  it("refuses unconfirmed or unverified corrections", () => {
    const loop = new HumanIntentLearnLoop();
    expect(() =>
      loop.recordCorrection({
        taskId: "unconfirmed",
        intent: searchIntent,
        uiState: ambiguousState,
        predictedStage: "login",
        correctedStage: "search",
        confirmedByUser: false,
        verification: { success: true, evidence: ["verified"] },
      }),
    ).toThrow("confirmed by the user");
    expect(() =>
      loop.recordCorrection({
        taskId: "unverified",
        intent: searchIntent,
        uiState: ambiguousState,
        predictedStage: "login",
        correctedStage: "search",
        confirmedByUser: true,
        verification: { success: false, evidence: [] },
      }),
    ).toThrow("verifier evidence");
  });

  it("detects a stable-intent prediction change before execution", () => {
    const loop = new HumanIntentLearnLoop({ minimumEvidence: 2 });
    const initial = loop.decide("drift-session", searchIntent, ambiguousState);
    expect(initial.prediction.predictedIntent).toBe("login");

    for (const taskId of ["drift-correction-1", "drift-correction-2"]) {
      loop.recordCorrection({
        taskId,
        intent: searchIntent,
        uiState: ambiguousState,
        predictedStage: "login",
        correctedStage: "search",
        confirmedByUser: true,
        verification: { success: true, evidence: ["verified"] },
      });
    }

    const changed = loop.decide("drift-session", searchIntent, ambiguousState);
    expect(changed.prediction.predictedIntent).toBe("search");
    expect(changed.drift.detected).toBe(true);
    expect(changed.admission).toBe("require_confirmation");
    expect(changed.drift.reasons.join(" ")).toContain("fingerprint stayed stable");
  });

  it("quarantines conflicting corrections and fails closed", () => {
    const loop = new HumanIntentLearnLoop({ minimumEvidence: 1 });
    loop.recordCorrection({
      taskId: "search-correction",
      intent: searchIntent,
      uiState: ambiguousState,
      predictedStage: "login",
      correctedStage: "search",
      confirmedByUser: true,
      verification: { success: true, evidence: ["verified"] },
    });
    loop.recordCorrection({
      taskId: "download-correction",
      intent: searchIntent,
      uiState: ambiguousState,
      predictedStage: "login",
      correctedStage: "download",
      confirmedByUser: true,
      verification: { success: true, evidence: ["verified"] },
    });

    expect(loop.listRules().every((rule) => rule.status === "quarantined")).toBe(
      true,
    );
    const decision = loop.decide("conflict-session", searchIntent, ambiguousState);
    expect(decision.prediction.predictedIntent).toBe("login");
    expect(decision.drift.detected).toBe(true);
    expect(decision.admission).toBe("require_confirmation");
  });

  it("never lowers risk or bypasses confirmation", () => {
    const loop = new HumanIntentLearnLoop({ minimumEvidence: 1 });
    const riskyIntent: UserIntent = {
      ...searchIntent,
      riskLevel: "high",
      requiresConfirmation: true,
    };
    loop.recordCorrection({
      taskId: "risky-correction",
      intent: riskyIntent,
      uiState: ambiguousState,
      predictedStage: "login",
      correctedStage: "search",
      confirmedByUser: true,
      verification: { success: true, evidence: ["verified"] },
    });

    const decision = loop.decide("risky-session", riskyIntent, ambiguousState);
    expect(decision.admission).toBe("require_confirmation");
    expect(decision.reason).toContain("cannot be lowered");
  });

  it("supports explicit revocation and bounded memory", () => {
    const loop = new HumanIntentLearnLoop({
      minimumEvidence: 1,
      maximumRules: 2,
    });
    const rule = loop.recordCorrection({
      taskId: "revoke-correction",
      intent: searchIntent,
      uiState: ambiguousState,
      predictedStage: "login",
      correctedStage: "search",
      confirmedByUser: true,
      verification: { success: true, evidence: ["verified"] },
    });
    expect(loop.revokeRule(rule.id)).toBe(true);
    expect(loop.decide("revoked", searchIntent, ambiguousState).prediction.predictedIntent).toBe(
      "login",
    );
    expect(loop.exportSnapshot().schemaVersion).toBe("lhic-learnloop-v1");
  });
});
