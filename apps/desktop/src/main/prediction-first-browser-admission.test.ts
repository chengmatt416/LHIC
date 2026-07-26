import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  HumanIntentLearnLoop,
  TrustedHumanIntentCorrectionIngestion,
  createSignedHumanIntentCorrectionApproval,
  type HumanIntentCorrectionBinding,
} from "@lhic/controller";
import type {
  BrowserExecutionPlan,
  NormalizedUIState,
  UserIntent,
} from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { DesktopHumanIntentAdmission } from "./prediction-first-browser-admission.js";

const searchPlan: BrowserExecutionPlan = {
  schemaVersion: "browser-plan-v1",
  goal: "Search for release notes",
  skillName: "search",
  requiredVariables: [],
  steps: [
    {
      id: "open-target",
      action: {
        scope: "browser",
        type: "navigate",
        intent: "Open the requested search page",
        target: "https://docs.example.test/search",
        methodPreference: ["api", "dom"],
        riskLevel: "low",
      },
      verification: {
        type: "url",
        description: "The requested search page is open",
        params: { equals: "https://docs.example.test/search" },
      },
    },
    {
      id: "fill-query",
      action: {
        scope: "browser",
        type: "fill",
        intent: "Fill the search query",
        target: "Search",
        value: "release notes",
        methodPreference: ["accessibility", "dom", "keyboard"],
        riskLevel: "low",
      },
      verification: {
        type: "dom",
        description: "A search input remains available after filling",
        params: { selector: "input[type=search]", state: "exists" },
      },
    },
    {
      id: "submit-query",
      action: {
        scope: "browser",
        type: "press",
        intent: "Submit the search query",
        target: "Search",
        value: "Enter",
        methodPreference: ["keyboard", "accessibility"],
        riskLevel: "low",
      },
      verification: {
        type: "url",
        description: "Search submission changes the page URL",
        params: { notEquals: "https://docs.example.test/search" },
      },
    },
  ],
};

const searchState: NormalizedUIState = {
  surface: "browser",
  url: "https://docs.example.test/search",
  title: "Documentation search",
  objects: [
    {
      id: "query",
      role: "searchbox",
      label: "Search",
      enabled: true,
      source: "dom",
      selector: "input[type=search]",
    },
  ],
  signals: {},
  capturedAt: "2026-07-27T00:00:00.000Z",
};

const ambiguousSearchState: NormalizedUIState = {
  ...searchState,
  objects: [
    ...searchState.objects,
    {
      id: "email",
      role: "textbox",
      label: "Email",
      enabled: true,
      source: "dom",
      selector: "#email",
    },
    {
      id: "password",
      role: "textbox",
      label: "Password",
      enabled: true,
      source: "dom",
      selector: "#password",
    },
  ],
};

const searchIntent: UserIntent = {
  goal: "Search for release notes",
  constraints: {},
  riskLevel: "low",
  requiresConfirmation: false,
  missingInformation: [],
};

const correctionTime = new Date("2026-07-27T00:00:01.000Z");

describe("DesktopHumanIntentAdmission", () => {
  it("admits a live-UI prediction only when the router reproduces the exact built-in plan", () => {
    const decision = new DesktopHumanIntentAdmission().evaluate(
      "task-search",
      "Search for release notes",
      searchPlan,
      searchState,
    );

    expect(decision.allowed).toBe(true);
    expect(decision.route.route.decision.path).toBe("fast");
    expect(decision.evidence).toContain(
      "Human Intent prediction ran against live normalized UI before task actions.",
    );
    expect(decision.evidence.join(" ")).not.toContain("release notes");
  });

  it("fails closed when the precompiled plan differs from the authoritative router", () => {
    const tamperedPlan: BrowserExecutionPlan = {
      ...searchPlan,
      steps: searchPlan.steps.map((step) =>
        step.id === "fill-query"
          ? {
              ...step,
              action: { ...step.action, target: "Different field" },
            }
          : step,
      ),
    };
    const decision = new DesktopHumanIntentAdmission().evaluate(
      "task-tampered",
      "Search for release notes",
      tamperedPlan,
      searchState,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.message).toContain("exact deterministic plan");
    expect(decision.evidence.join(" ")).toContain("actionMatch=false");
  });

  it("blocks an ambiguous low-confidence UI instead of executing optimistically", () => {
    const decision = new DesktopHumanIntentAdmission().evaluate(
      "task-ambiguous",
      "Search for release notes",
      searchPlan,
      ambiguousSearchState,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.route.route.decision.path).toBe("slow");
  });

  it("applies signed corrections to the exact LearnLoop used for runtime admission", () => {
    const keyPair = generateKeyPairSync("ed25519");
    const learnLoop = new HumanIntentLearnLoop({
      minimumTrainingEvidence: 2,
      minimumValidationEvidence: 1,
    });
    const ingestion = new TrustedHumanIntentCorrectionIngestion({
      publicKey: keyPair.publicKey,
      now: () => correctionTime,
    });
    const admission = new DesktopHumanIntentAdmission({
      learnLoop,
      correctionIngestion: ingestion,
    });

    expect(
      admission.evaluate(
        "before-corrections",
        searchIntent.goal,
        searchPlan,
        ambiguousSearchState,
      ).allowed,
    ).toBe(false);

    for (const taskId of ["desktop-training-1", "desktop-training-2"]) {
      ingestSignedCorrection(
        admission,
        correctionBinding(taskId, "training", ambiguousSearchState),
        keyPair.privateKey,
      );
    }
    const validationState: NormalizedUIState = {
      ...ambiguousSearchState,
      objects: [
        ...ambiguousSearchState.objects,
        {
          id: "help",
          role: "button",
          label: "Help",
          enabled: true,
          source: "dom",
          selector: "#help",
        },
      ],
    };
    const active = ingestSignedCorrection(
      admission,
      correctionBinding("desktop-validation", "validation", validationState),
      keyPair.privateKey,
    );
    expect(active.status).toBe("active");

    const decision = admission.evaluate(
      "after-corrections",
      searchIntent.goal,
      searchPlan,
      ambiguousSearchState,
    );
    expect(decision.route.humanIntent.basePrediction.predictedIntent).toBe(
      "login",
    );
    expect(decision.route.humanIntent.prediction.predictedIntent).toBe(
      "search",
    );
    expect(decision.route.humanIntent.appliedRuleIds).toEqual([active.id]);
    expect(decision.allowed).toBe(true);
  });

  it("keeps correction ingestion disabled unless a trusted verifier is explicitly configured", () => {
    const admission = new DesktopHumanIntentAdmission();
    const binding = correctionBinding(
      "not-configured",
      "training",
      ambiguousSearchState,
    );
    const keyPair = generateKeyPairSync("ed25519");
    const approval = createSignedHumanIntentCorrectionApproval(
      binding,
      "reviewer",
      keyPair.privateKey,
      { now: correctionTime },
    );

    expect(() => admission.ingestCorrection(binding, approval)).toThrow(
      "not configured",
    );
  });
});

function correctionBinding(
  taskId: string,
  split: "training" | "validation",
  uiState: NormalizedUIState,
): HumanIntentCorrectionBinding {
  return {
    taskId,
    traceSha256: hashState({ taskId, kind: "desktop-trace" }),
    verifierVersion: "desktop-verifier-v1",
    split,
    intent: searchIntent,
    uiState,
    predictedStage: "login",
    correctedStage: "search",
    verification: {
      success: true,
      evidence: ["The requested search result was verified."],
    },
  };
}

function ingestSignedCorrection(
  admission: DesktopHumanIntentAdmission,
  binding: HumanIntentCorrectionBinding,
  privateKey: Parameters<typeof createSignedHumanIntentCorrectionApproval>[2],
) {
  const approval = createSignedHumanIntentCorrectionApproval(
    binding,
    "desktop-reviewer",
    privateKey,
    { now: correctionTime },
  );
  return admission.ingestCorrection(binding, approval);
}
