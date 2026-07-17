import { describe, expect, it } from "vitest";

import { parseDemoCommandOptions } from "./demo-command-options.js";

describe("demo command options", () => {
  it("accepts an interactive custom endpoint and viewable mode", () => {
    expect(
      parseDemoCommandOptions([
        "--viewable",
        "--endpoint",
        "https://models.example.test/v1/responses",
      ]),
    ).toEqual({
      safe: false,
      viewable: true,
      endpoint: "https://models.example.test/v1/responses",
    });
  });

  it("accepts the compact view alias for the safe fixture", () => {
    expect(parseDemoCommandOptions(["--safe", "--view"])).toEqual({
      safe: true,
      viewable: true,
    });
  });

  it("rejects unsupported, incomplete, and conflicting options", () => {
    expect(() => parseDemoCommandOptions(["--endpoint"])).toThrow(
      "requires an absolute URL",
    );
    expect(() =>
      parseDemoCommandOptions([
        "--safe",
        "--endpoint",
        "https://models.example.test",
      ]),
    ).toThrow("does not use a model endpoint");
    expect(() => parseDemoCommandOptions(["--other"])).toThrow(
      "Unknown demo option",
    );
  });
});
