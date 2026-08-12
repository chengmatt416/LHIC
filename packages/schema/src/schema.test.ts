import { describe, expect, it } from "vitest";

import {
  isNormalizedUIState,
  isBrowserExecutionPlan,
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
      isSemanticAction({
        type: "tab",
        intent: "switch tab",
        tabAction: "switch",
        tabIndex: -1,
        methodPreference: ["api"],
        riskLevel: "low",
      }),
    ).toBe(false);
    expect(
      isSemanticAction({
        type: "keyboard",
        intent: "press a key",
        key: "Enter",
        modifiers: ["Control", 1],
        methodPreference: ["keyboard"],
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

  it("requires upload plans to bind a non-empty local path to a target", () => {
    const uploadPlan = {
      schemaVersion: "browser-plan-v1",
      goal: "Upload an approved fixture",
      requiredVariables: [{ name: "fixture", prompt: "Approved fixture path" }],
      steps: [
        {
          id: "upload-fixture",
          action: {
            type: "upload",
            intent: "upload the caller-selected fixture",
            target: "attachment",
            filePath: "{{variables.fixture}}",
            methodPreference: ["dom"],
            riskLevel: "low",
          },
          verification: {
            type: "dom",
            description: "attachment is selected",
            params: { selector: "#attachment" },
          },
        },
      ],
    };

    expect(isBrowserExecutionPlan(uploadPlan)).toBe(true);
    expect(
      isBrowserExecutionPlan({
        ...uploadPlan,
        steps: [
          {
            ...uploadPlan.steps[0],
            action: { ...uploadPlan.steps[0]!.action, filePath: "" },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isBrowserExecutionPlan({
        ...uploadPlan,
        steps: [
          {
            ...uploadPlan.steps[0],
            action: { ...uploadPlan.steps[0]!.action, target: "" },
          },
        ],
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
    expect(
      isGlobalComputerAction({
        scope: "os",
        type: "os_click",
        intent: "click a semantic desktop control",
        target: "Save",
        application: "TextEdit",
        methodPreference: ["accessibility"],
        riskLevel: "medium",
        verifier: { type: "active_window", application: "TextEdit" },
      }),
    ).toBe(true);
    expect(
      isGlobalComputerAction({
        scope: "os",
        type: "os_scroll",
        intent: "reject an unbounded desktop scroll",
        methodPreference: ["mouse"],
        riskLevel: "medium",
        scrollDirection: "down",
        scrollAmount: 10_000,
        verifier: { type: "active_window", application: "TextEdit" },
      }),
    ).toBe(false);
    expect(
      isGlobalComputerAction({
        scope: "os",
        type: "os_clipboard",
        intent: "reject a clipboard action without an operation",
        methodPreference: ["api"],
        riskLevel: "high",
        verifier: { type: "active_window", application: "TextEdit" },
      }),
    ).toBe(false);
  });
});
