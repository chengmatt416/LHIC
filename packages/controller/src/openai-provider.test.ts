import { describe, expect, it, vi } from "vitest";

import { OpenAISlowPathProvider } from "./openai-provider.js";

const request = {
  taskId: "openai-slow-1",
  userIntent: {
    goal: "Find the quarterly report",
    constraints: {},
    riskLevel: "low" as const,
    requiresConfirmation: false,
    missingInformation: [],
  },
  uiState: {
    surface: "browser" as const,
    objects: [],
    signals: {},
    capturedAt: "2026-07-16T00:00:00.000Z",
  },
  recentTrace: [
    {
      eventId: "trace-1",
      type: "action",
      taskId: "openai-slow-1",
      timestamp: "2026-07-16T00:00:00.000Z",
      payload: { target: "Password", value: "not-for-the-model" },
    },
  ],
  reason: "low_confidence" as const,
};

const validPlan = {
  decision: "propose_plan",
  message: "Search for the report.",
  proposedActions: [
    {
      scope: "browser",
      type: "fill",
      intent: "enter the report query",
      target: "Search",
      value: "quarterly report",
      methodPreference: ["accessibility"],
      riskLevel: "low",
    },
  ],
};

describe("OpenAISlowPathProvider", () => {
  it("is disabled by default and makes no network request", async () => {
    const provider = new OpenAISlowPathProvider({
      enabled: false,
      fetchImplementation: async () => {
        throw new Error("must not be called");
      },
    });

    await expect(provider.reason(request)).resolves.toEqual({
      decision: "blocked",
      message: "OpenAI Slow Path is disabled by default.",
    });
  });

  it("requires an API key when explicitly enabled", async () => {
    const provider = new OpenAISlowPathProvider({
      enabled: true,
      apiKey: "",
      fetchImplementation: async () => {
        throw new Error("must not be called");
      },
    });

    await expect(provider.reason(request)).resolves.toEqual({
      decision: "blocked",
      message:
        "OpenAI Slow Path is enabled but OPENAI_API_KEY is not configured.",
    });
  });

  it("rejects endpoints that could expose the API key in transit", () => {
    expect(
      () =>
        new OpenAISlowPathProvider({
          enabled: true,
          apiKey: "test-key",
          endpoint: "http://models.example.test/v1/responses",
        }),
    ).toThrow("OpenAI endpoint must use HTTPS");
    expect(
      () =>
        new OpenAISlowPathProvider({
          enabled: true,
          apiKey: "test-key",
          endpoint: "https://user:password@models.example.test/v1/responses",
        }),
    ).toThrow("OpenAI endpoint cannot contain credentials");
  });

  it("uses the Responses API with a strict schema and redacted request", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const provider = new OpenAISlowPathProvider({
      enabled: true,
      apiKey: "test-key",
      fetchImplementation: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  { type: "output_text", text: JSON.stringify(validPlan) },
                ],
              },
            ],
          }),
        );
      },
    });

    await expect(provider.reason(request)).resolves.toEqual(validPlan);
    expect(capturedBody).toMatchObject({
      model: "gpt-5.6",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "lhic_slow_path_plan",
          strict: true,
        },
      },
    });
    expect(JSON.stringify(capturedBody)).not.toContain("not-for-the-model");
    expect(JSON.stringify(capturedBody)).toContain("[REDACTED]");
  });

  it("blocks invalid semantic actions instead of passing them to an executor", async () => {
    const provider = new OpenAISlowPathProvider({
      enabled: true,
      apiKey: "test-key",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      ...validPlan,
                      proposedActions: [
                        {
                          ...validPlan.proposedActions[0],
                          methodPreference: [],
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
        ),
    });

    await expect(provider.reason(request)).resolves.toEqual({
      decision: "blocked",
      message:
        "OpenAI Slow Path returned a plan that failed LHIC semantic-action validation.",
    });
  });

  it("surfaces a model refusal without treating it as a plan", async () => {
    const provider = new OpenAISlowPathProvider({
      enabled: true,
      apiKey: "test-key",
      fetchImplementation: async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [
                  { type: "refusal", refusal: "I cannot help with that." },
                ],
              },
            ],
          }),
        ),
    });

    await expect(provider.reason(request)).resolves.toEqual({
      decision: "blocked",
      message: "OpenAI Slow Path refused the request: I cannot help with that.",
    });
  });

  it("bounds a never-settling fetch and aborts its request signal", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const provider = new OpenAISlowPathProvider({
        enabled: true,
        apiKey: "test-key",
        timeoutMs: 20,
        fetchImplementation: (_input, init) => {
          requestSignal = init?.signal ?? undefined;
          return Promise.withResolvers<Response>().promise;
        },
      });

      const result = provider.reason(request);
      await vi.advanceTimersByTimeAsync(20);

      await expect(result).resolves.toEqual({
        decision: "blocked",
        message: "OpenAI Slow Path timed out after 20 ms.",
      });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
