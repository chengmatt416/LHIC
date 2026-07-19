import { describe, expect, it } from "vitest";

import { parsePublicWebTrainingOptions } from "./public-web-training.js";

describe("public web training command options", () => {
  it("accepts an explicit scenario, a safe public query, and optional runtime settings", () => {
    expect(
      parsePublicWebTrainingOptions([
        "wikipedia-search",
        "--query",
        "human computer interaction",
        "--database",
        "test-data/skills.sqlite",
        "--viewable",
      ]),
    ).toEqual({
      scenarioId: "wikipedia-search",
      query: "human computer interaction",
      databaseFile: "test-data/skills.sqlite",
      headless: false,
    });
  });

  it("rejects incomplete, unsafe, and unknown training options", () => {
    expect(() => parsePublicWebTrainingOptions([])).toThrow("scenario");
    expect(() =>
      parsePublicWebTrainingOptions(["mdn-search", "--query"]),
    ).toThrow("requires a value");
    expect(() =>
      parsePublicWebTrainingOptions([
        "mdn-search",
        "--query",
        "person@example.com",
      ]),
    ).toThrow("personally identifiable");
    expect(() =>
      parsePublicWebTrainingOptions([
        "mdn-search",
        "--query",
        "CSS grid",
        "--unknown",
      ]),
    ).toThrow("Unknown public-web training option");
    expect(() =>
      parsePublicWebTrainingOptions([
        "mdn-search",
        "--query",
        "CSS grid",
        "--promote",
      ]),
    ).toThrow("was removed");
  });
});
