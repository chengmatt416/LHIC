import { describe, expect, it } from "vitest";

import { ClaudeSlowPathProvider } from "./claude-provider.js";
import { FastPathRouter } from "./fast-path-router.js";

const request = {
  taskId: "slow-1",
  userIntent: {
    goal: "search",
    constraints: {},
    riskLevel: "low" as const,
    requiresConfirmation: false,
    missingInformation: [],
  },
  uiState: {
    surface: "browser" as const,
    objects: [],
    signals: {},
    capturedAt: "2026-07-15T00:00:00.000Z",
  },
  recentTrace: [],
  reason: "low_confidence" as const,
};

describe("Slow Path interfaces", () => {
  it("delegates a slow decision through a provider without binding Fast Path to a vendor", async () => {
    const router = new FastPathRouter({
      reason: async () => ({ decision: "ask_user", message: "Need a query." }),
    });
    const response = await router.invokeSlowPath(
      { path: "slow", reason: "ambiguous", confidence: 0.5 },
      request,
    );
    expect(response).toEqual({
      decision: "ask_user",
      message: "Need a query.",
    });
  });

  it("keeps the optional Claude adapter disabled by default without performing a request", async () => {
    const provider = new ClaudeSlowPathProvider({
      enabled: false,
      fetchImplementation: async () => {
        throw new Error("must not be called");
      },
    });
    await expect(provider.reason(request)).resolves.toEqual({
      decision: "blocked",
      message: "Claude Slow Path is disabled by default.",
    });
  });
});
