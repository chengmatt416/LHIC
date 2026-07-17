import { afterEach, describe, expect, it } from "vitest";

import { startGuiCompanion, type GuiCompanion } from "./gui-companion.js";

const companions: GuiCompanion[] = [];

afterEach(async () => {
  await Promise.all(companions.splice(0).map((companion) => companion.close()));
});

describe("GUI companion", () => {
  it("serves the local GUI and renders reviewed MCP configuration", async () => {
    let openedUrl: string | undefined;
    const companion = await startGuiCompanion({
      initialTab: "mcp",
      workspaceRoot: "/tmp/Computer Intent",
      openBrowser: async (url) => {
        openedUrl = url;
      },
    });
    companions.push(companion);
    const token = new URL(companion.url).searchParams.get("token")!;

    expect(openedUrl).toBe(companion.url);
    await expect(
      fetch(companion.url).then((response) => response.text()),
    ).resolves.toContain("MCP Link Companion");
    const unauthorized = await fetch(apiUrl(companion, "/api/mcp/config"), {
      method: "POST",
    });
    expect(unauthorized.status).toBe(401);

    const response = await jsonRequest(companion, token, "/api/mcp/config", {
      harness: "codex",
      workspaceRoot: "/tmp/Computer Intent",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      config: expect.stringContaining("[mcp_servers.lhic_computer_use]"),
    });
  });

  it("feeds initial GUI values into the visible demo and forwards later input", async () => {
    let completeDemo: (() => void) | undefined;
    const demoCompleted = new Promise<void>((resolve) => {
      completeDemo = resolve;
    });
    const companion = await startGuiCompanion({
      openBrowser: async () => undefined,
      runDemo: async (prompter) => {
        expect(
          await prompter.prompt(
            "Model provider (openai, gemini, claude)",
            "openai",
          ),
        ).toBe("gemini");
        expect(
          await prompter.prompt(
            "Custom model endpoint URL (optional; provider-compatible)",
          ),
        ).toBe("");
        expect(
          await prompter.prompt("Use the saved gemini API key? (yes/no)", "no"),
        ).toBe("no");
        expect(
          await prompter.promptSecret(
            "gemini API key (stored in your OS Keychain)",
          ),
        ).toBe("gui-test-secret");
        expect(
          await prompter.prompt("Model ID for gemini", "gemini-2.5-flash"),
        ).toBe("gemini-test");
        expect(await prompter.prompt("Public HTTPS website URL")).toBe(
          "https://example.test",
        );
        expect(await prompter.prompt("Slow Path task prompt")).toBe(
          "find a test item",
        );
        expect(
          await prompter.prompt("Approve click for search? (yes/no)", "no"),
        ).toBe("yes");
        completeDemo?.();
      },
    });
    companions.push(companion);
    const token = new URL(companion.url).searchParams.get("token")!;
    const events = await fetch(
      `${apiUrl(companion, "/api/demo/events")}?token=${encodeURIComponent(token)}`,
    );
    const reader = events.body!.getReader();
    await reader.read();

    const started = await jsonRequest(companion, token, "/api/demo/start", {
      provider: "gemini",
      endpoint: "",
      apiKey: "gui-test-secret",
      model: "gemini-test",
      websiteUrl: "https://example.test",
      slowTask: "find a test item",
    });
    expect(started.status).toBe(202);

    const event = await readEvent(reader);
    expect(event).toMatchObject({
      type: "input_required",
      message: expect.stringContaining("Approve click"),
    });
    expect(JSON.stringify(event)).not.toContain("gui-test-secret");
    const response = await jsonRequest(companion, token, "/api/demo/respond", {
      promptId: event.promptId,
      value: "yes",
    });
    expect(response.status).toBe(200);
    await demoCompleted;
    await reader.cancel();
  });
});

function apiUrl(companion: GuiCompanion, path: string): string {
  const url = new URL(companion.url);
  url.pathname = path;
  url.search = "";
  return url.toString();
}

async function jsonRequest(
  companion: GuiCompanion,
  token: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(apiUrl(companion, path), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-LHIC-Companion-Token": token,
    },
    body: JSON.stringify(body),
  });
}

async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let received = "";
  for (let index = 0; index < 5; index += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
    const matches = [...received.matchAll(/data: (.+)\n\n/g)];
    const event = matches
      .map((match) => JSON.parse(match[1]!) as Record<string, unknown>)
      .find((candidate) => candidate.type === "input_required");
    if (event) return event;
  }
  throw new Error("The GUI companion did not request the expected input.");
}
