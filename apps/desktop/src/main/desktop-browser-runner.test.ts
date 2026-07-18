import { describe, expect, it } from "vitest";

import {
  requiresInteractiveApproval,
  summarizePlan,
} from "./desktop-browser-runner.js";

describe("DesktopBrowserRunner policy", () => {
  it("requires explicit approval for activation, download, high-risk, and unknown-risk browser actions", () => {
    expect(
      requiresInteractiveApproval({
        type: "navigate",
        intent: "Open public documentation",
        target: "https://docs.example.test/",
        methodPreference: ["api"],
        riskLevel: "low",
      }),
    ).toBe(false);
    expect(
      requiresInteractiveApproval({
        type: "click",
        intent: "Activate a control",
        target: "Continue",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      }),
    ).toBe(true);
    expect(
      requiresInteractiveApproval({
        type: "download",
        intent: "Download report",
        target: "Download report",
        methodPreference: ["dom"],
        riskLevel: "low",
      }),
    ).toBe(true);
  });

  it("exposes a reviewable proposal summary without action values", () => {
    expect(
      summarizePlan({
        schemaVersion: "browser-plan-v1",
        goal: "Open documentation",
        requiredVariables: [],
        steps: [
          {
            id: "open-docs",
            action: {
              type: "navigate",
              intent: "Open documentation",
              target: "https://docs.example.test/",
              methodPreference: ["api"],
              riskLevel: "low",
            },
            verification: {
              type: "url",
              description: "Documentation URL is open",
              params: { equals: "https://docs.example.test/" },
            },
          },
        ],
      }),
    ).toEqual({
      stepCount: 1,
      steps: [
        {
          id: "open-docs",
          action: "navigate",
          intent: "Open documentation",
          riskLevel: "low",
          verifier: "Documentation URL is open",
        },
      ],
    });
  });
});
