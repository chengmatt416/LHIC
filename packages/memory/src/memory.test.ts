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
