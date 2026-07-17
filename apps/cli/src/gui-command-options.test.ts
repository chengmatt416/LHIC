import { describe, expect, it } from "vitest";

import { parseGuiCommandOptions } from "./gui-command-options.js";

describe("GUI companion command options", () => {
  it("selects an initial companion screen and preserves no-open mode", () => {
    expect(parseGuiCommandOptions(["mcp", "--no-open"])).toEqual({
      initialTab: "mcp",
      openBrowser: false,
    });
    expect(parseGuiCommandOptions([])).toEqual({
      initialTab: "demo",
      openBrowser: true,
    });
  });

  it("rejects conflicting and unknown GUI options", () => {
    expect(() => parseGuiCommandOptions(["demo", "mcp"])).toThrow(
      "one initial tab",
    );
    expect(() => parseGuiCommandOptions(["--other"])).toThrow(
      "Unknown gui option",
    );
  });
});
