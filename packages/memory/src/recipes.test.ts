import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMemoryDatabase, SkillStore } from "./skill-store.js";
import { extractRecipeCandidate, recipeFingerprint } from "./recipes.js";

describe("verified recipe extraction", () => {
  let directory: string;
  let skillStore: SkillStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-recipe-"));
    skillStore = new SkillStore(
      createMemoryDatabase(join(directory, "skills.sqlite")),
    );
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const definition = {
    compiler: "slow-path-v1",
    goal: "Search docs",
    constraints: { query: "release notes" },
    templateVariables: ["constraints.query"],
    actions: [
      {
        type: "navigate",
        intent: "Search docs",
        target: "docs.example.test",
        methodPreference: ["dom"],
        riskLevel: "low",
      },
      {
        type: "click",
        intent: "Open result",
        target: "#result",
        methodPreference: ["dom"],
        riskLevel: "low",
      },
    ],
    verification: [],
  };

  function recordRun(taskId: string, uiFingerprint: string): void {
    skillStore.recordCandidateSuccess(
      "candidate-1",
      definition as Record<string, unknown>,
      { success: true, evidence: ["run passed"] },
      taskId,
      {
        source: "slow_path",
        environment: "production",
        origin: "https://docs.example.test",
        uiFingerprint: Buffer.from(`${taskId}-${uiFingerprint}-fp`)
          .toString("hex")
          .padEnd(64, "0")
          .slice(0, 64),
        traceSha256: Buffer.from(`${taskId}-${uiFingerprint}-trace`)
          .toString("hex")
          .padEnd(64, "0")
          .slice(0, 64),
        verifierVersion: "lhic-verifier-v1",
      },
    );
  }

  it("extracts a recipe only after independent runs plus holdout", () => {
    recordRun("task-1", "fp-1");
    recordRun("task-2", "fp-2");
    recordRun("task-3", "fp-3");
    skillStore.recordCandidateHoldout(
      "candidate-1",
      { success: true, evidence: ["holdout passed"] },
      {
        evaluator: "offline-evaluation-v1",
        environment: "local_fixture",
        evaluationId: "eval-1",
        origin: "https://docs.example.test",
        uiFingerprint: Buffer.from("holdout-fp")
          .toString("hex")
          .padEnd(64, "0")
          .slice(0, 64),
        verifierVersion: "lhic-verifier-v1",
        candidateDefinitionSha256:
          skillStore.getCandidate("candidate-1")!.definitionSha256,
      },
    );
    const recipe = extractRecipeCandidate(skillStore, "candidate-1");
    expect(recipe).toBeDefined();
    expect(recipe?.evidence.independentRuns).toBe(3);
    expect(recipe?.evidence.holdoutPassed).toBe(true);
    expect(recipe?.risk.classes).toContain("read");
    expect(recipe?.parameters).toEqual([{ name: "query" }]);
    expect(recipeFingerprint(recipe!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never extracts from a single success or repeated same task IDs", () => {
    recordRun("task-1", "fp-1");
    expect(extractRecipeCandidate(skillStore, "candidate-1")).toBeUndefined();
    // Repeated same task id does not count as independent evidence.
    recordRun("task-1", "fp-2");
    recordRun("task-1", "fp-3");
    expect(extractRecipeCandidate(skillStore, "candidate-1")).toBeUndefined();
  });

  it("requires the holdout before extraction", () => {
    recordRun("task-1", "fp-1");
    recordRun("task-2", "fp-2");
    recordRun("task-3", "fp-3");
    expect(extractRecipeCandidate(skillStore, "candidate-1")).toBeUndefined();
  });

  it("refuses extraction when credential-like literals survive redaction", () => {
    const secretDefinition = JSON.parse(JSON.stringify(definition)) as Record<
      string,
      unknown
    >;
    (secretDefinition.actions as Array<Record<string, unknown>>)[0] = {
      type: "fill",
      intent: "fill api key",
      target: "#key",
      value: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789",
      methodPreference: ["dom"],
      riskLevel: "low",
    };
    // A fresh candidate carries the secret-bearing definition.
    skillStore.recordCandidateSuccess(
      "candidate-secret",
      secretDefinition as Record<string, unknown>,
      { success: true, evidence: ["run passed"] },
      `task-secret-${Math.random()}`,
      {
        source: "slow_path",
        environment: "production",
        origin: "https://docs.example.test",
        uiFingerprint: Buffer.from(`secret-fp-${Math.random()}`)
          .toString("hex")
          .padEnd(64, "0")
          .slice(0, 64),
        traceSha256: Buffer.from(`secret-trace-${Math.random()}`)
          .toString("hex")
          .padEnd(64, "0")
          .slice(0, 64),
        verifierVersion: "lhic-verifier-v1",
      },
    );
    skillStore.recordCandidateHoldout(
      "candidate-secret",
      { success: true, evidence: ["holdout passed"] },
      {
        evaluator: "offline-evaluation-v1",
        environment: "local_fixture",
        evaluationId: "eval-secret",
        origin: "https://docs.example.test",
        uiFingerprint: Buffer.from("holdout-fp-secret")
          .toString("hex")
          .padEnd(64, "0")
          .slice(0, 64),
        verifierVersion: "lhic-verifier-v1",
        candidateDefinitionSha256:
          skillStore.getCandidate("candidate-secret")!.definitionSha256,
      },
    );
    expect(
      extractRecipeCandidate(skillStore, "candidate-secret"),
    ).toBeUndefined();
  });
});
