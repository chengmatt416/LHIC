import { describe, expect, it } from "vitest";

import { createDemoModelProvider } from "./demo-model-provider.js";

const state = {
  surface: "browser" as const,
  url: "https://example.test",
  objects: [],
  signals: {},
  capturedAt: "2026-07-17T00:00:00.000Z",
};

const nextAction = {
  status: "next_action",
  message: "Fill the query.",
  step: {
    id: "fill-query",
    action: {
      scope: "browser",
      type: "fill",
      intent: "fill query",
      target: "Search",
      value: "notebook",
      methodPreference: ["accessibility"],
      riskLevel: "low",
    },
    verification: {
      type: "dom",
      description: "field visible",
      params: { selector: "#query" },
    },
  },
  requiredVariables: [],
};

describe("structured demo model providers", () => {
  it.each([
    [
      "openai",
      {
        output: [
          {
            content: [
              {
                text: JSON.stringify(nextAction).slice(
                  0,
                  Math.floor(JSON.stringify(nextAction).length / 2),
                ),
              },
            ],
          },
          {
            content: [
              {
                text: JSON.stringify(nextAction).slice(
                  Math.floor(JSON.stringify(nextAction).length / 2),
                ),
              },
            ],
          },
        ],
      },
    ],
    [
      "gemini",
      {
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: JSON.stringify(nextAction) }],
          },
        ],
      },
    ],
    [
      "claude",
      {
        content: [
          {
            type: "text",
            text: JSON.stringify(nextAction).slice(
              0,
              Math.floor(JSON.stringify(nextAction).length / 2),
            ),
          },
          {
            type: "text",
            text: JSON.stringify(nextAction).slice(
              Math.floor(JSON.stringify(nextAction).length / 2),
            ),
          },
        ],
      },
    ],
  ] as const)(
    "validates %s structured responses",
    async (provider, responseBody) => {
      let requestBody: Record<string, unknown> | undefined;
      const providerClient = createDemoModelProvider({
        provider,
        apiKey: "test-openai-key",
        model: "test-model",
        fetchImplementation: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return new Response(JSON.stringify(responseBody), { status: 200 });
        },
      });

      const response = await providerClient.nextStep({
        task: "search",
        uiState: state,
      });
      expect(response).toMatchObject({
        status: "next_action",
        step: { id: "fill-query" },
      });
      expect(JSON.stringify(requestBody)).toContain(
        provider === "gemini" ? "response_format" : "json_schema",
      );
      if (provider === "gemini") {
        expect(requestBody).toMatchObject({ store: false });
      }
      const serializedRequest = JSON.stringify(requestBody);
      expect(serializedRequest).toContain('"upload"');
      expect(serializedRequest).toContain('"filePath"');
      expect(serializedRequest).toContain("never infer or invent a local path");
      expect(serializedRequest.match(/You are LHIC Slow Path/g)).toHaveLength(
        1,
      );
      if (provider === "openai") {
        expect(requestBody).toMatchObject({
          max_output_tokens: 1_200,
          instructions: expect.stringContaining("You are LHIC Slow Path"),
          input: [
            {
              role: "user",
              content: expect.stringMatching(/^Task: /),
            },
          ],
        });
      }
      if (provider === "claude") {
        expect(requestBody).toMatchObject({
          max_tokens: 1_200,
          system: expect.stringContaining("You are LHIC Slow Path"),
          messages: [
            {
              role: "user",
              content: expect.stringMatching(/^Task: /),
            },
          ],
        });
      }
    },
  );

  it("removes volatile UI values and bounds observation context", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const providerClient = createDemoModelProvider({
      provider: "openai",
      apiKey: "test-openai-key",
      model: "test-model",
      fetchImplementation: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            output: [{ content: [{ text: JSON.stringify(nextAction) }] }],
          }),
          { status: 200 },
        );
      },
    });
    const objects = Array.from({ length: 300 }, (_, index) => ({
      id: `control-${index}`,
      role: "button",
      label: "x".repeat(2_000),
      value: "typed-secret",
      source: "dom" as const,
    }));

    await providerClient.nextStep({
      task: "search",
      uiState: { ...state, objects, signals: { volatile: "opaque-secret" } },
    });

    const serializedInput = JSON.stringify(requestBody?.input) ?? "";
    expect(serializedInput).not.toContain("typed-secret");
    expect(serializedInput).not.toContain("opaque-secret");
    expect(serializedInput.length).toBeLessThan(14_000);
  });

  it("rejects a credentialed remote HTTP endpoint before sending the API key", async () => {
    let fetchCalls = 0;
    const providerClient = createDemoModelProvider({
      provider: "openai",
      apiKey: "test-openai-key",
      model: "test-model",
      endpoint: "http://models.example.test/v1/responses",
      fetchImplementation: async () => {
        fetchCalls += 1;
        throw new Error("must not be called");
      },
    });

    await expect(
      providerClient.nextStep({ task: "search", uiState: state }),
    ).rejects.toThrow("must use HTTPS");
    expect(fetchCalls).toBe(0);
  });

  it("sends a structured request to an explicitly selected endpoint", async () => {
    let requestUrl: string | undefined;
    const providerClient = createDemoModelProvider({
      provider: "openai",
      apiKey: "test-openai-key",
      model: "test-model",
      endpoint: "https://models.example.test/v1/responses",
      fetchImplementation: async (url) => {
        requestUrl = String(url);
        return new Response(
          JSON.stringify({
            output: [{ content: [{ text: JSON.stringify(nextAction) }] }],
          }),
          { status: 200 },
        );
      },
    });

    await providerClient.nextStep({ task: "search", uiState: state });

    expect(requestUrl).toBe("https://models.example.test/v1/responses");
  });
});
