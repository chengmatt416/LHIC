import { describe, expect, it } from "vitest";

import {
  isNormalizedUIState,
  isGlobalComputerAction,
  isRiskLevel,
  isSemanticAction,
  isTraceEvent,
  isUserIntent,
  isVerificationCondition,
  type SemanticAction,
  type UserIntent,
} from "./index.js";

describe("core schema contracts", () => {
  it("accepts complete intent, UI state, action, verifier, and trace values", () => {
    const intent: UserIntent = {
      goal: "search the catalogue",
      constraints: {},
      riskLevel: "low",
      requiresConfirmation: false,
      missingInformation: [],
    };
    const action: SemanticAction = {
      type: "fill",
      intent: "fill search query",
      target: "input[type=search]",
      value: "keyboard",
      methodPreference: ["dom", "accessibility"],
      riskLevel: "low",
    };

    expect(isRiskLevel("medium")).toBe(true);
    expect(isUserIntent(intent)).toBe(true);
    expect(
      isNormalizedUIState({
        surface: "browser",
        objects: [],
        signals: {},
        capturedAt: new Date().toISOString(),
      }),
    ).toBe(true);
    expect(isSemanticAction(action)).toBe(true);
    expect(
      isVerificationCondition({
        type: "url",
        description: "contains search",
        params: { contains: "q=" },
      }),
    ).toBe(true);
    expect(
      isVerificationCondition({
        type: "file",
        description: "download exists",
        params: {
          filePath: "/tmp/download.txt",
          allowedRoot: "/tmp",
          minSize: 1,
        },
        timeoutMs: 10_000,
      }),
    ).toBe(true);
    expect(
      isTraceEvent({
        eventId: "event-1",
        taskId: "task-1",
        timestamp: new Date().toISOString(),
        type: "action_completed",
        payload: {},
      }),
    ).toBe(true);
  });

  it("rejects unrecognized action methods and risk levels", () => {
    expect(
      isSemanticAction({
        type: "click",
        intent: "continue",
        methodPreference: ["mouse"],
        riskLevel: "not-a-risk-level",
      }),
    ).toBe(false);
    expect(
      isSemanticAction({
        type: "click",
        intent: "continue",
        methodPreference: ["unsupported-method"],
        riskLevel: "low",
      }),
    ).toBe(false);
    expect(
      isVerificationCondition({
        type: "dom",
        description: "invalid state",
        params: { selector: "#save", state: "nonsense" },
        timeoutMs: -1,
      }),
    ).toBe(false);
    expect(
      isVerificationCondition({
        type: "file",
        description: "unscoped file",
        params: { filePath: "/tmp/download.txt" },
      }),
    ).toBe(false);
  });

  it("accepts a verified global computer action and rejects incomplete input", () => {
    const action: SemanticAction = {
      scope: "os",
      type: "os_type",
      intent: "type a documented value into the active editor",
      methodPreference: ["keyboard"],
      riskLevel: "high",
      text: "approved text",
      verifier: {
        type: "active_window",
        application: "TextEdit",
      },
    };

    expect(isGlobalComputerAction(action)).toBe(true);
    expect(isSemanticAction(action)).toBe(true);
    expect(
      isGlobalComputerAction({
        ...action,
        verifier: { type: "active_window" },
        text: undefined,
      }),
    ).toBe(false);
  });
});
