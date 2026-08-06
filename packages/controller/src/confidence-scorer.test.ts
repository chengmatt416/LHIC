import { describe, expect, it } from "vitest";

import type { NormalizedUIState, UserIntent } from "@lhic/schema";

import { scoreConfidence } from "./confidence-scorer.js";
import type { StageClassification } from "./stage-classifier.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeIntent(overrides: Partial<UserIntent> = {}): UserIntent {
  return {
    goal: "Search for notebooks",
    constraints: {},
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
    ...overrides,
  };
}

function makeClassification(
  overrides: Partial<StageClassification> = {},
): StageClassification {
  return {
    stage: "search",
    candidates: ["search"],
    evidence: ["Search field is available."],
    ...overrides,
  };
}

const richBrowserState: NormalizedUIState = {
  surface: "browser",
  url: "https://example.test/search",
  title: "Search - Example",
  objects: [
    { id: "q", role: "searchbox", label: "Search", source: "dom" },
    { id: "btn", role: "button", label: "Find", source: "dom" },
    { id: "nav", role: "navigation", label: "Main", source: "dom" },
    { id: "h1", role: "heading", label: "Results", source: "dom" },
    { id: "link1", role: "link", label: "Item 1", source: "dom" },
    { id: "link2", role: "link", label: "Item 2", source: "dom" },
    { id: "link3", role: "link", label: "Item 3", source: "dom" },
    { id: "link4", role: "link", label: "Item 4", source: "dom" },
  ],
  signals: {},
  capturedAt: "2026-07-15T00:00:00.000Z",
};

const sparseState: NormalizedUIState = {
  surface: "unknown",
  objects: [{ id: "a", role: "text", source: "ocr" }],
  signals: {},
  capturedAt: "2026-07-15T00:00:00.000Z",
};

const loginState: NormalizedUIState = {
  surface: "browser",
  url: "https://example.test/login",
  objects: [
    { id: "email", role: "textbox", label: "Email", source: "dom" },
    { id: "pw", role: "textbox", label: "Password", source: "dom" },
    { id: "btn", role: "button", label: "Sign in", source: "dom" },
  ],
  signals: {},
  capturedAt: "2026-07-15T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scoreConfidence", () => {
  // --- Range ---

  it("always returns a value between 0 and 1", () => {
    const stages: Array<StageClassification> = [
      makeClassification({ stage: "unknown", candidates: [], evidence: [] }),
      makeClassification(),
      makeClassification({ candidates: ["search", "login", "download"] }),
    ];
    const risks: Array<UserIntent["riskLevel"]> = [
      "low",
      "medium",
      "high",
      "unknown",
    ];
    const states: Array<NormalizedUIState | undefined> = [
      undefined,
      sparseState,
      richBrowserState,
    ];
    const histories = [undefined, 0, 0.5, 1];

    for (const classification of stages) {
      for (const riskLevel of risks) {
        const intent = makeIntent({ riskLevel });
        for (const uiState of states) {
          for (const historicalSuccessRate of histories) {
            const result = scoreConfidence(classification, intent, {
              uiState,
              historicalSuccessRate,
            });
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  // --- Stage factor ---

  it("returns a low score for unknown stage", () => {
    // With sparse UI and unknown risk, unknown stage should score very low.
    const score = scoreConfidence(
      makeClassification({ stage: "unknown", candidates: [], evidence: [] }),
      makeIntent({ riskLevel: "unknown" }),
      { uiState: sparseState },
    );
    expect(score).toBeLessThan(0.25);
  });

  it("unknown stage scores below known stage even with default options", () => {
    const unknown = scoreConfidence(
      makeClassification({ stage: "unknown", candidates: [], evidence: [] }),
      makeIntent(),
    );
    const known = scoreConfidence(makeClassification(), makeIntent());
    expect(unknown).toBeLessThan(known);
  });

  it("returns a high score for a single unambiguous candidate", () => {
    const score = scoreConfidence(makeClassification(), makeIntent());
    expect(score).toBeGreaterThan(0.8);
  });

  it("decreases smoothly as candidate count grows", () => {
    const base = scoreConfidence(makeClassification(), makeIntent());

    const two = scoreConfidence(
      makeClassification({ candidates: ["search", "login"] }),
      makeIntent(),
    );
    const three = scoreConfidence(
      makeClassification({ candidates: ["search", "login", "download"] }),
      makeIntent(),
    );
    const four = scoreConfidence(
      makeClassification({
        candidates: ["search", "login", "download", "form_filling"],
      }),
      makeIntent(),
    );

    expect(base).toBeGreaterThan(two);
    expect(two).toBeGreaterThan(three);
    expect(three).toBeGreaterThan(four);
    // Even with 4 candidates, score stays positive.
    expect(four).toBeGreaterThan(0);
  });

  // --- Risk factor ---

  it("ranks risk levels: low > medium > unknown > high", () => {
    const classification = makeClassification();
    const low = scoreConfidence(classification, makeIntent({ riskLevel: "low" }));
    const medium = scoreConfidence(
      classification,
      makeIntent({ riskLevel: "medium" }),
    );
    const unknown = scoreConfidence(
      classification,
      makeIntent({ riskLevel: "unknown" }),
    );
    const high = scoreConfidence(
      classification,
      makeIntent({ riskLevel: "high" }),
    );

    expect(low).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(high);
  });

  // --- UI quality ---

  it("scores higher with a rich browser UI state than with a sparse one", () => {
    const classification = makeClassification();
    const intent = makeIntent();

    const rich = scoreConfidence(classification, intent, {
      uiState: richBrowserState,
    });
    const sparse = scoreConfidence(classification, intent, {
      uiState: sparseState,
    });

    expect(rich).toBeGreaterThan(sparse);
  });

  it("uses a neutral default when no UI state is provided", () => {
    const classification = makeClassification();
    const intent = makeIntent();

    const withoutUI = scoreConfidence(classification, intent);
    // Should still give a reasonably high score for a clear single candidate.
    expect(withoutUI).toBeGreaterThan(0.8);
  });

  it("increases score when stage-relevant controls are present", () => {
    const loginClassification = makeClassification({
      stage: "login",
      candidates: ["login"],
      evidence: ["Login fields found."],
    });
    const intent = makeIntent();

    const withLoginFields = scoreConfidence(loginClassification, intent, {
      uiState: loginState,
    });
    const withGenericFields = scoreConfidence(loginClassification, intent, {
      uiState: sparseState,
    });

    expect(withLoginFields).toBeGreaterThan(withGenericFields);
  });

  it("gives a bonus for browser surface over unknown surface", () => {
    const classification = makeClassification();
    const intent = makeIntent();

    const browserScore = scoreConfidence(classification, intent, {
      uiState: richBrowserState,
    });
    const nonBrowser: NormalizedUIState = {
      ...richBrowserState,
      surface: "unknown",
    };
    const nonBrowserScore = scoreConfidence(classification, intent, {
      uiState: nonBrowser,
    });

    expect(browserScore).toBeGreaterThan(nonBrowserScore);
  });

  // --- Historical success rate ---

  it("increases score with a high historical success rate", () => {
    const classification = makeClassification();
    const intent = makeIntent();

    const noHistory = scoreConfidence(classification, intent);
    const goodHistory = scoreConfidence(classification, intent, {
      historicalSuccessRate: 0.95,
    });
    const badHistory = scoreConfidence(classification, intent, {
      historicalSuccessRate: 0.1,
    });

    expect(goodHistory).toBeGreaterThan(noHistory);
    expect(noHistory).toBeGreaterThan(badHistory);
  });

  it("clamps out-of-range historical success rates", () => {
    const classification = makeClassification();
    const intent = makeIntent();

    const overOne = scoreConfidence(classification, intent, {
      historicalSuccessRate: 1.5,
    });
    const underZero = scoreConfidence(classification, intent, {
      historicalSuccessRate: -0.5,
    });

    expect(overOne).toBeLessThanOrEqual(1);
    expect(underZero).toBeGreaterThanOrEqual(0);
  });

  // --- Smooth gradients ---

  it("produces smooth gradients — no discrete jumps between adjacent inputs", () => {
    const classification = makeClassification();
    const intent = makeIntent();

    // Sweep historical success rate from 0 to 1 in small steps.
    let prev = scoreConfidence(classification, intent, {
      historicalSuccessRate: 0,
    });
    for (let h = 0.05; h <= 1; h += 0.05) {
      const curr = scoreConfidence(classification, intent, {
        historicalSuccessRate: h,
      });
      // Each step should change by at most a small delta (0.30 weight * 0.05 step = 0.015).
      expect(Math.abs(curr - prev)).toBeLessThan(0.02);
      prev = curr;
    }
  });

  it("produces smooth gradients when candidate count grows", () => {
    const intent = makeIntent();
    // Each additional candidate should decrease score by a diminishing amount.
    const scores = [1, 2, 3, 4, 5].map((n) =>
      scoreConfidence(
        makeClassification({
          candidates: Array.from({ length: n }, (_, i) => {
            const stages = [
              "search",
              "login",
              "download",
              "form_filling",
              "test_web_flow",
            ] as const;
            return stages[i];
          }),
        }),
        intent,
      ),
    );

    for (let i = 1; i < scores.length; i++) {
      const delta = scores[i - 1] - scores[i];
      // Decrease should be positive and diminishing (or at least not growing).
      expect(delta).toBeGreaterThan(0);
      if (i >= 2) {
        const prevDelta = scores[i - 2] - scores[i - 1];
        expect(delta).toBeLessThanOrEqual(prevDelta + 0.001);
      }
    }
  });

  // --- Backward compatibility ---

  it("works with only two positional arguments (no options)", () => {
    // This is the existing call signature used by predictor.ts.
    const score = scoreConfidence(makeClassification(), makeIntent());
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  // --- Combined factors ---

  it("scores best-case (single candidate, rich UI, low risk, good history) near 1", () => {
    const score = scoreConfidence(makeClassification(), makeIntent(), {
      uiState: richBrowserState,
      historicalSuccessRate: 0.95,
    });
    expect(score).toBeGreaterThan(0.85);
  });

  it("scores worst-case (unknown stage, sparse UI, high risk, bad history) near 0", () => {
    const score = scoreConfidence(
      makeClassification({ stage: "unknown", candidates: [], evidence: [] }),
      makeIntent({ riskLevel: "high" }),
      {
        uiState: sparseState,
        historicalSuccessRate: 0.05,
      },
    );
    expect(score).toBeLessThan(0.2);
  });
});
