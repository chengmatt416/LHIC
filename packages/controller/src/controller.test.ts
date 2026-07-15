import { describe, expect, it } from "vitest";

import type { NormalizedUIState } from "@lhic/schema";

import { compileActions } from "./action-compiler.js";
import { ContextEngine } from "./context-engine.js";
import { FastPathRouter } from "./fast-path-router.js";
import { parseUserIntent } from "./intent-parser.js";
import { predictIntent } from "./predictor.js";

const searchState: NormalizedUIState = {
  surface: "browser",
  url: "https://example.test",
  objects: [
    {
      id: "search",
      role: "textbox",
      label: "Search",
      source: "dom",
      selector: "#search",
    },
  ],
  signals: {},
  capturedAt: "2026-07-15T00:00:00.000Z",
};

describe("intent parser", () => {
  it.each([
    ["Log in to https://example.com", "login"],
    ["Sign in to the customer portal", "login"],
    ["Search for notebooks", "search"],
    ["Find invoices on https://example.com", "search"],
    ["Download the report", "download"],
    ["Export customer data as CSV", "download"],
    ["Fill the contact form", "fill_form"],
    ["Populate my profile fields", "fill_form"],
    ["Test the checkout flow", "test_web_flow"],
    ["Verify the website flow", "test_web_flow"],
  ])("parses %s", (command, operation) => {
    expect(parseUserIntent(command).constraints.operation).toBe(operation);
  });

  it("marks destructive goals as confirmation-required", () => {
    expect(parseUserIntent("Delete the production record")).toMatchObject({
      riskLevel: "high",
      requiresConfirmation: true,
    });
  });
});

describe("local controller", () => {
  it("stores context and predicts a clear search Fast Path", () => {
    const intent = parseUserIntent("Search for notebooks");
    const context = new ContextEngine("task-1", intent.goal);
    context.setUIState(searchState);
    context.completeStep("observed");
    expect(context.snapshot()).toMatchObject({
      currentUrl: "https://example.test",
      completedSteps: ["observed"],
    });

    const prediction = predictIntent(intent, searchState);
    expect(prediction).toMatchObject({
      predictedIntent: "search",
      skillName: "search",
      confidence: 0.9,
    });
    const compiled = compileActions(prediction, intent);
    expect(compiled.actions).toHaveLength(2);
    expect(
      new FastPathRouter().decide(prediction, intent, compiled.actions).path,
    ).toBe("fast");
  });

  it("classifies login, form, download, test, and ambiguous local stages", () => {
    const loginPrediction = predictIntent(parseUserIntent("Log in"), {
      ...searchState,
      objects: [
        { id: "email", role: "textbox", label: "Email", source: "dom" },
        { id: "password", role: "textbox", label: "Password", source: "dom" },
      ],
    });
    expect(loginPrediction).toMatchObject({
      predictedIntent: "login",
      skillName: "login",
      confidence: 0.9,
    });

    const formPrediction = predictIntent(parseUserIntent("Fill the form"), {
      ...searchState,
      objects: [
        { id: "name", role: "textbox", label: "Name required", source: "dom" },
        {
          id: "submit",
          role: "button",
          label: "Submit",
          enabled: false,
          source: "dom",
        },
      ],
    });
    expect(formPrediction).toMatchObject({
      predictedIntent: "form_filling",
      skillName: "fill_form",
      confidence: 0.9,
    });

    const downloadPrediction = predictIntent(
      parseUserIntent("Download report"),
      {
        ...searchState,
        objects: [
          { id: "download", role: "button", label: "Download", source: "dom" },
        ],
      },
    );
    expect(downloadPrediction).toMatchObject({
      predictedIntent: "download",
      skillName: "download_file",
      confidence: 0.9,
    });

    const testPrediction = predictIntent(
      parseUserIntent("Test the checkout flow"),
      searchState,
    );
    expect(testPrediction).toMatchObject({
      predictedIntent: "test_web_flow",
      skillName: "test_web_flow",
      confidence: 0.9,
    });

    const ambiguousPrediction = predictIntent(
      parseUserIntent("Search for books and verify the flow"),
      searchState,
    );
    expect(ambiguousPrediction).toMatchObject({
      predictedIntent: "search",
      confidence: 0.6,
    });
  });

  it("keeps ambiguous, medium, high, and unknown risk work off Fast Path", () => {
    const lowPrediction = {
      predictedIntent: "search" as const,
      skillName: "search" as const,
      confidence: 0.9,
      evidence: [],
    };
    const router = new FastPathRouter();
    expect(
      router.decide(
        { ...lowPrediction, confidence: 0.6 },
        parseUserIntent("Search for books"),
      ).path,
    ).toBe("slow");
    expect(
      router.decide(lowPrediction, {
        ...parseUserIntent("Search for books"),
        riskLevel: "medium",
      }).path,
    ).toBe("slow");
    expect(
      router.decide(lowPrediction, parseUserIntent("Delete account")).path,
    ).toBe("ask_user");
    expect(
      router.decide(lowPrediction, {
        ...parseUserIntent("Search for books"),
        riskLevel: "unknown",
        requiresConfirmation: true,
      }).path,
    ).toBe("ask_user");
  });
});
