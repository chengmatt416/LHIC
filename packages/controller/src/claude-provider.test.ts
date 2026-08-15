import { describe, expect, it, vi } from "vitest";

import { ClaudeSlowPathProvider } from "./claude-provider.js";

describe("ClaudeSlowPathProvider", () => {
  it("rejects endpoints that could expose the API key in transit", () => {
    expect(
      () =>
        new ClaudeSlowPathProvider({
          enabled: true,
          apiKey: "test-key",
          endpoint: "http://models.example.test/v1/messages",
        }),
    ).toThrow("Claude endpoint must use HTTPS");
    expect(
      () =>
        new ClaudeSlowPathProvider({
          enabled: true,
          apiKey: "test-key",
          endpoint: "https://user:password@models.example.test/v1/messages",
        }),
    ).toThrow("Claude endpoint cannot contain credentials");
  });

  it("bounds a never-settling fetch even when it ignores abort", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const provider = new ClaudeSlowPathProvider({
        enabled: true,
        apiKey: "test-key",
        timeoutMs: 20,
        fetchImplementation: (_input, init) => {
          requestSignal = init?.signal ?? undefined;
          return Promise.withResolvers<Response>().promise;
        },
      });

      const result = provider.reason({
        taskId: "timeout",
        userIntent: {
          goal: "search documentation",
          constraints: {},
          riskLevel: "low",
          requiresConfirmation: false,
          missingInformation: [],
        },
        uiState: {
          surface: "browser",
          objects: [],
          signals: {},
          capturedAt: "2026-08-09T00:00:00.000Z",
        },
        recentTrace: [],
        reason: "low_confidence",
      });
      await vi.advanceTimersByTimeAsync(20);

      await expect(result).resolves.toEqual({
        decision: "blocked",
        message: "Claude Slow Path timed out after 20 ms.",
      });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
