import { describe, expect, it } from "vitest";

import { type CliPrompter, guideCliArguments } from "./interactive.js";

function createPrompter(responses: string[]): CliPrompter {
  return {
    interactive: true,
    prompt: async () => responses.shift() ?? "",
    close: () => undefined,
  };
}

describe("interactive CLI guidance", () => {
  it("guides shared skill enablement from the short command", async () => {
    const argumentsList = await guideCliArguments(
      ["shared", "enable"],
      createPrompter([
        "https://taipei.cloud.appwrite.io/v1",
        "project-123",
        "https://functions.example.com",
        "person@example.com",
      ]),
    );

    expect(argumentsList).toEqual([
      "shared",
      "enable",
      "--endpoint",
      "https://taipei.cloud.appwrite.io/v1",
      "--project",
      "project-123",
      "--function-url",
      "https://functions.example.com",
      "--email",
      "person@example.com",
    ]);
  });

  it("retains supplied shared-skill values and prompts only for missing ones", async () => {
    const argumentsList = await guideCliArguments(
      [
        "shared",
        "enable",
        "--endpoint",
        "https://taipei.cloud.appwrite.io/v1",
        "--project",
        "project-123",
      ],
      createPrompter(["https://functions.example.com", "person@example.com"]),
    );

    expect(argumentsList).toEqual([
      "shared",
      "enable",
      "--endpoint",
      "https://taipei.cloud.appwrite.io/v1",
      "--project",
      "project-123",
      "--function-url",
      "https://functions.example.com",
      "--email",
      "person@example.com",
    ]);
  });

  it("guides missing required arguments for other command groups", async () => {
    await expect(
      guideCliArguments(["mcp", "config"], createPrompter(["codex"])),
    ).resolves.toEqual(["mcp", "config", "codex"]);
    await expect(
      guideCliArguments(["bench", "readiness"], createPrompter(["webarena"])),
    ).resolves.toEqual(["bench", "readiness", "webarena"]);
    await expect(
      guideCliArguments(["run", "action"], createPrompter(["action.json"])),
    ).resolves.toEqual(["run", "action", "action.json"]);
    await expect(
      guideCliArguments(["run", "plan"], createPrompter(["plan.json"])),
    ).resolves.toEqual(["run", "plan", "plan.json"]);
  });

  it("expands single-purpose command shortcuts without extra prompts", async () => {
    const prompter = createPrompter(["codex", "trace.json"]);

    await expect(guideCliArguments(["global"], prompter)).resolves.toEqual([
      "global",
      "doctor",
    ]);
    await expect(
      guideCliArguments(["bench", "simulate"], prompter),
    ).resolves.toEqual(["bench", "simulate", "resilience"]);
    await expect(guideCliArguments(["mcp"], prompter)).resolves.toEqual([
      "mcp",
      "config",
      "codex",
    ]);
    await expect(guideCliArguments(["trace"], prompter)).resolves.toEqual([
      "trace",
      "inspect",
      "trace.json",
    ]);
  });

  it("starts an interactive guide when no command is provided", async () => {
    await expect(
      guideCliArguments([], createPrompter(["global doctor"])),
    ).resolves.toEqual(["global", "doctor"]);
  });

  it("guides every demo suffix option from the root menu", async () => {
    await expect(
      guideCliArguments(
        [],
        createPrompter(["demo", "safe fixture", "viewable"]),
      ),
    ).resolves.toEqual(["demo", "--safe", "--viewable"]);
    await expect(
      guideCliArguments(
        [],
        createPrompter([
          "demo",
          "interactive learning",
          "https://models.example.test/v1/responses",
        ]),
      ),
    ).resolves.toEqual([
      "demo",
      "--endpoint",
      "https://models.example.test/v1/responses",
    ]);
  });

  it("guides the local GUI companion from the root menu", async () => {
    await expect(
      guideCliArguments([], createPrompter(["gui", "mcp", "no"])),
    ).resolves.toEqual(["gui", "mcp", "--no-open"]);
  });

  it("guides a requested CLI or desktop installation", async () => {
    await expect(
      guideCliArguments(["install"], createPrompter(["desktop"])),
    ).resolves.toEqual(["install", "desktop"]);
    await expect(
      guideCliArguments(["install", "cli"], createPrompter([])),
    ).resolves.toEqual(["install", "cli"]);
  });

  it("re-prompts after an invalid guided choice", async () => {
    await expect(
      guideCliArguments(["mcp", "config"], createPrompter(["other", "codex"])),
    ).resolves.toEqual(["mcp", "config", "codex"]);
  });

  it("keeps non-interactive invocations safe for scripts and CI", async () => {
    const prompter: CliPrompter = {
      interactive: false,
      prompt: async () => "",
      close: () => undefined,
    };

    await expect(
      guideCliArguments(["shared", "enable"], prompter),
    ).rejects.toThrow("Missing required input");
  });
});
