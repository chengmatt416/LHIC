import { describe, expect, it } from "vitest";

import { compileLocalFastPath } from "./fast-path-planner.js";

describe("compileLocalFastPath", () => {
  it("compiles a deterministic local search plan without provider input", () => {
    expect(
      compileLocalFastPath({
        goal: "Search for release notes",
        startUrl: "https://docs.example.test/search",
      }),
    ).toMatchObject({
      skillName: "search",
      steps: [
        expect.objectContaining({ id: "open-target" }),
        expect.objectContaining({ id: "fill-query" }),
        expect.objectContaining({ id: "submit-query" }),
      ],
    });
  });

  it("refuses non-browser URL schemes and ambiguous goals", () => {
    expect(
      compileLocalFastPath({
        goal: "Search for release notes",
        startUrl: "file:///private/document.html",
      }),
    ).toBeUndefined();
    expect(
      compileLocalFastPath({
        goal: "Open the release notes",
        startUrl: "https://docs.example.test/",
      }),
    ).toBeUndefined();
  });
});
