import { afterEach, describe, expect, it, vi } from "vitest";

import type { NormalizedUIState, UserIntent } from "@lhic/schema";
import type { SkillRecord } from "@lhic/memory";

import { SkillCache } from "./skill-cache.js";

const browserState: NormalizedUIState = {
  surface: "browser",
  objects: [],
  signals: {},
  capturedAt: "2026-01-01T00:00:00.000Z",
};

function skill(name: string, goal: string): SkillRecord {
  return {
    name,
    definition: { goal, surface: "browser" },
    lifecycle: "verified",
    successCount: 1,
    failureCount: 0,
  };
}

function intent(goal: string): UserIntent {
  return {
    goal,
    constraints: {},
    riskLevel: "low",
    requiresConfirmation: false,
    missingInformation: [],
  };
}

describe("SkillCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the updated usage metadata on a cache hit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const cache = new SkillCache();
    cache.put(skill("search", "search documentation"));

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    const cached = cache.get("search");

    expect(cached).toMatchObject({
      useCount: 1,
      lastUsedAt: new Date("2026-01-01T00:00:01.000Z").getTime(),
    });
  });

  it("refreshes a cached skill without evicting another entry", () => {
    const cache = new SkillCache({ maxSize: 2 });
    cache.put(skill("search", "search documentation"));
    cache.put(skill("checkout", "checkout basket"));
    cache.put(skill("search", "find account settings"));

    expect(cache.stats().size).toBe(2);
    expect(cache.get("checkout")?.skill.name).toBe("checkout");
    expect(
      cache.findBestMatch(intent("find account settings"), browserState)?.skill
        .name,
    ).toBe("search");
  });
});
