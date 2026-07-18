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
    );
    store.recordCandidateSuccess(
      "candidate-search",
      { value: "secret@example.com" },
      evidence,
      "task-1",
    );
    store.recordCandidateSuccess(
      "candidate-search",
      { value: "secret@example.com" },
      evidence,
      "task-2",
    );
    store.recordCandidateSuccess(
      "candidate-search",
      { value: "secret@example.com" },
      evidence,
      "task-3",
    );

    expect(store.getCandidate("candidate-search")).toMatchObject({
      verifiedRunCount: 3,
      holdoutPassed: false,
      promoted: false,
      definition: { value: "[REDACTED_EMAIL]" },
    });
    expect(store.promoteCandidate("candidate-search")).toBeUndefined();

    store.recordCandidateHoldout("candidate-search", evidence);
    expect(store.promoteCandidate("candidate-search")).toMatchObject({
      lifecycle: "habit",
      successCount: 3,
    });
    expect(store.getCandidate("candidate-search")).toMatchObject({
      promoted: true,
    });
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
