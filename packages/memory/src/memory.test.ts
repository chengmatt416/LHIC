import { afterEach, describe, expect, it } from "vitest";

import { FailureMemory } from "./failure-memory.js";
import { SelectorMemory } from "./selector-memory.js";
import { createMemoryDatabase, SkillStore } from "./skill-store.js";

describe("SQLite skill memory", () => {
  const databases: ReturnType<typeof createMemoryDatabase>[] = [];

  afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
  });

  it("only promotes skills with successful verifier evidence", () => {
    const database = createMemoryDatabase();
    databases.push(database);
    const store = new SkillStore(database);
    expect(() =>
      store.recordVerifiedSuccess(
        "search",
        { password: "never-store" },
        { success: false, evidence: [] },
      ),
    ).toThrow("successful verifier evidence");

    const evidence = { success: true, evidence: ["Result visible"] };
    let skill = store.recordVerifiedSuccess(
      "search",
      { password: "never-store" },
      evidence,
    );
    expect(skill).toMatchObject({
      lifecycle: "verified",
      successCount: 1,
      definition: { password: "[REDACTED]" },
    });
    skill = store.recordVerifiedSuccess("search", {}, evidence);
    skill = store.recordVerifiedSuccess("search", {}, evidence);
    expect(skill.lifecycle).toBe("habit");
    for (let index = 0; index < 7; index += 1) {
      skill = store.recordVerifiedSuccess("search", {}, evidence);
    }
    expect(skill).toMatchObject({ lifecycle: "trusted", successCount: 10 });
  });

  it("preloads draft skills without replacing learned definitions", () => {
    const database = createMemoryDatabase();
    databases.push(database);
    const store = new SkillStore(database);

    expect(store.preload("search", { source: "builtin" })).toMatchObject({
      lifecycle: "draft",
      successCount: 0,
      definition: { source: "builtin" },
    });
    store.recordVerifiedSuccess(
      "search",
      { source: "learned" },
      { success: true, evidence: ["Search results visible"] },
    );

    expect(store.preload("search", { source: "replacement" })).toMatchObject({
      lifecycle: "verified",
      successCount: 1,
      definition: { source: "learned" },
    });
  });

  it("keeps learned Slow Path work as a candidate until independent runs and holdout pass", () => {
    const database = createMemoryDatabase();
    databases.push(database);
    const store = new SkillStore(database);
    const evidence = { success: true, evidence: ["verified"] };

    store.recordCandidateSuccess(
      "candidate-search",
      { value: "secret@example.com" },
      evidence,
      "task-1",
      candidateRun("task-1", "a"),
    );
    store.recordCandidateSuccess(
      "candidate-search",
      { value: "secret@example.com" },
      evidence,
      "task-1",
      candidateRun("task-1", "a"),
    );
    store.recordCandidateSuccess(
      "candidate-search",
      { value: "secret@example.com" },
      evidence,
      "task-2",
      candidateRun("task-2", "b"),
    );
    store.recordCandidateSuccess(
      "candidate-search",
      { value: "secret@example.com" },
      evidence,
      "task-3",
      candidateRun("task-3", "c"),
    );

    expect(store.getCandidate("candidate-search")).toMatchObject({
      verifiedRunCount: 3,
      holdoutPassed: false,
      promoted: false,
      definition: { value: "[REDACTED_EMAIL]" },
    });
    expect(store.promoteCandidate("candidate-search")).toBeUndefined();

    const candidate = store.getCandidate("candidate-search");
    store.recordCandidateHoldout("candidate-search", evidence, {
      evaluator: "offline-evaluation-v1",
      environment: "local_fixture",
      evaluationId: "holdout-search-1",
      origin: "http://localhost:4173",
      uiFingerprint: "f".repeat(64),
      verifierVersion: "lhic-verifier-v1",
      candidateDefinitionSha256: candidate!.definitionSha256,
    });
    expect(store.promoteCandidate("candidate-search")).toMatchObject({
      lifecycle: "habit",
      successCount: 3,
    });
    expect(store.getCandidate("candidate-search")).toMatchObject({
      promoted: true,
    });
  });

  it("rejects promotion evidence that reuses a training UI fingerprint", () => {
    const database = createMemoryDatabase();
    databases.push(database);
    const store = new SkillStore(database);
    const evidence = { success: true, evidence: ["verified"] };
    for (const [index, trace] of ["a", "b", "c"].entries()) {
      store.recordCandidateSuccess(
        "candidate-ui",
        { source: "verified" },
        evidence,
        `task-${index}`,
        candidateRun(`task-${index}`, trace),
      );
    }
    const candidate = store.getCandidate("candidate-ui")!;
    expect(() =>
      store.recordCandidateHoldout("candidate-ui", evidence, {
        evaluator: "offline-evaluation-v1",
        environment: "local_fixture",
        evaluationId: "task-0",
        origin: "http://localhost:4173",
        uiFingerprint: "f".repeat(64),
        verifierVersion: "lhic-verifier-v1",
        candidateDefinitionSha256: candidate.definitionSha256,
      }),
    ).toThrow("separate evaluation identifier");
    expect(() =>
      store.recordCandidateHoldout("candidate-ui", evidence, {
        evaluator: "offline-evaluation-v1",
        environment: "local_fixture",
        evaluationId: "holdout-ui-1",
        origin: "http://localhost:4173",
        uiFingerprint: "a".repeat(64),
        verifierVersion: "lhic-verifier-v1",
        candidateDefinitionSha256: candidate.definitionSha256,
      }),
    ).toThrow("UI fingerprint");
    expect(store.promoteCandidate("candidate-ui")).toBeUndefined();
  });

  it("lists skills by lifecycle and verified success count without exposing SQL rows", () => {
    const database = createMemoryDatabase();
    databases.push(database);
    const store = new SkillStore(database);
    store.preload("draft-skill", { source: "builtin" });
    store.recordVerifiedSuccess(
      "verified-skill",
      { source: "learned" },
      { success: true, evidence: ["verified"] },
    );
    store.recordVerifiedSuccess(
      "habit-skill",
      { source: "learned" },
      { success: true, evidence: ["verified"] },
    );
    store.recordVerifiedSuccess(
      "habit-skill",
      { source: "learned" },
      { success: true, evidence: ["verified"] },
    );
    store.recordVerifiedSuccess(
      "habit-skill",
      { source: "learned" },
      { success: true, evidence: ["verified"] },
    );

    expect(store.list()).toEqual([
      expect.objectContaining({
        name: "habit-skill",
        lifecycle: "habit",
        successCount: 3,
      }),
      expect.objectContaining({
        name: "verified-skill",
        lifecycle: "verified",
        successCount: 1,
      }),
      expect.objectContaining({ name: "draft-skill", lifecycle: "draft" }),
    ]);
    expect(() => store.list(0)).toThrow("between 1 and 1000");
  });

  it("stores verified selectors and turns repeated failures into recovery recommendations", () => {
    const database = createMemoryDatabase();
    databases.push(database);
    const selectors = new SelectorMemory(database);
    expect(
      selectors.remember(
        { skillName: "search", target: "search box", selector: "#search" },
        { success: false, evidence: [] },
      ),
    ).toBe(false);
    expect(
      selectors.remember(
        {
          skillName: "search",
          target: "search box",
          selector: "#search",
          label: "Search",
        },
        { success: true, evidence: ["verified"] },
      ),
    ).toBe(true);
    expect(selectors.find("search", "search box")[0]).toMatchObject({
      selector: "#search",
      successCount: 1,
    });
    expect(selectors.list()).toEqual([
      expect.objectContaining({
        skillName: "search",
        target: "search box",
        selector: "#search",
        successCount: 1,
      }),
    ]);
    expect(() => selectors.list(0)).toThrow("between 1 and 1000");

    const failures = new FailureMemory(database);
    expect(failures.record("download_file", "download_timeout")).toMatchObject({
      suggestsUpdatedSkillRule: false,
    });
    expect(failures.record("download_file", "download_timeout")).toMatchObject({
      recommendation:
        "Retry the trigger once, then inspect network and filesystem evidence.",
      suggestsUpdatedSkillRule: true,
    });
  });
});

function candidateRun(taskId: string, traceCharacter: string) {
  return {
    source: "slow_path" as const,
    environment: "production" as const,
    origin: "https://docs.example.test",
    uiFingerprint: "a".repeat(64),
    traceSha256: traceCharacter.repeat(64),
    verifierVersion: `lhic-verifier-v1-${taskId}`,
  };
}
