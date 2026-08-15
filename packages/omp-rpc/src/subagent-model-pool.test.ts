import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SubagentModelPool,
  connectedSelectors,
  parseModelCatalog,
  reconcileSubagentModels,
} from "./subagent-model-pool.js";

const temporaryDirectories: string[] = [];

const catalog = [
  {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    reasoning: true,
    image: true,
    contextWindow: 128_000,
    thinkingLevels: ["low", "high"],
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-1",
    reasoning: true,
  },
];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SubagentModelPool", () => {
  it("intersects persisted selectors with the live connected catalog", () => {
    expect(
      connectedSelectors(catalog, [
        "openai-codex/gpt-5.6-sol",
        "missing/offline",
        "openai-codex/gpt-5.6-sol",
        "bad\nselector/model",
      ]),
    ).toEqual(["openai-codex/gpt-5.6-sol"]);
  });

  it("rejects disconnected and frontmatter-injection selectors", () => {
    expect(() => reconcileSubagentModels(catalog, ["missing/model"])).toThrow(
      "not connected",
    );
    expect(() =>
      reconcileSubagentModels(catalog, [
        'openai-codex/gpt-5.6-sol"\nspawns: "*',
      ]),
    ).toThrow("Invalid subagent model selector");
  });

  it("atomically regenerates exact non-recursive model agents and removes stale files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-model-pool-"));
    temporaryDirectories.push(directory);
    const extensionRoot = join(directory, "pool");
    const pool = new SubagentModelPool(extensionRoot);

    const first = await pool.generate(catalog, [
      "openai-codex/gpt-5.6-sol",
      "anthropic/claude-opus-4-1",
    ]);
    expect(first.models).toHaveLength(2);
    const firstFiles = await readdir(join(extensionRoot, "agents"));
    expect(firstFiles).toHaveLength(2);
    expect(first.models[0]!.agentName).toMatch(
      /^model-openai-codex-gpt-5-6-sol-[a-f0-9]{8}$/,
    );
    const definition = await readFile(
      join(extensionRoot, "agents", `${first.models[0]!.agentName}.md`),
      "utf8",
    );
    expect(definition).toContain('model: "openai-codex/gpt-5.6-sol"');
    expect(definition).toContain("spawns: []");
    expect(definition).not.toMatch(/tools:.*(?:task|eval)/);

    const second = await pool.generate(catalog, ["anthropic/claude-opus-4-1"]);
    expect(second.models).toHaveLength(1);
    expect(await readdir(join(extensionRoot, "agents"))).toEqual([
      `${second.models[0]!.agentName}.md`,
    ]);
  });

  it("normalizes capability metadata from the live RPC catalog", () => {
    expect(
      parseModelCatalog({
        models: [
          {
            provider: "openai-codex",
            id: "gpt-5.6-sol",
            name: "GPT 5.6 Sol",
            reasoning: true,
            input: ["text", "image"],
            contextWindow: 128_000,
            thinking: { mode: "effort", efforts: ["low", "high"] },
          },
        ],
      }),
    ).toEqual([
      {
        provider: "openai-codex",
        id: "gpt-5.6-sol",
        displayName: "GPT 5.6 Sol",
        reasoning: true,
        image: true,
        contextWindow: 128_000,
        thinkingLevels: ["low", "high"],
      },
    ]);
  });
});
