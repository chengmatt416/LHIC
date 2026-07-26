import { describe, expect, it } from "vitest";

import type { BrowserExecutionPlan, NormalizedUIState } from "@lhic/schema";

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
    const ambiguousState: NormalizedUIState = {
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
    const decision = new DesktopHumanIntentAdmission().evaluate(
      "task-ambiguous",
      "Search for release notes",
      searchPlan,
      ambiguousState,
    );

    expect(decision.allowed).toBe(false);
    expect(decision.route.route.decision.path).toBe("slow");
  });
});
