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
      { output: [{ content: [{ text: JSON.stringify(nextAction) }] }] },
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
      { content: [{ type: "text", text: JSON.stringify(nextAction) }] },
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
    },
  );

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
