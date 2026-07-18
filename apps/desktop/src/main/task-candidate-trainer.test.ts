import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { recordTaskCandidate } from "./task-candidate-trainer.js";

const plan = {
  schemaVersion: "browser-plan-v1" as const,
  goal: "Open public docs",
  requiredVariables: [],
  steps: [
    {
      id: "open",
      action: {
        scope: "browser" as const,
        type: "navigate" as const,
        intent: "Open documentation",
        target: "https://docs.example.test/",
        methodPreference: ["api" as const],
        riskLevel: "low" as const,
      },
      verification: {
        type: "url" as const,
        description: "Documentation is open",
        params: { equals: "https://docs.example.test/" },
      },
    },
  ],
};

describe("recordTaskCandidate", () => {
  it("records independently verified Slow Path browser runs as local candidates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-candidate-"));
    try {
      const first = await recordTaskCandidate(directory, "task-one", plan);
      const second = await recordTaskCandidate(directory, "task-two", plan);

      expect(first.name).toBe(second.name);
      expect(first.verifiedRunCount).toBe(1);
      expect(second.verifiedRunCount).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
