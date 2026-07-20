import { describe, expect, it } from "vitest";

import { parseCliReleaseTag } from "./check-cli-release-tag.mjs";

describe("CLI release tag", () => {
  it("parses the isolated CLI release namespace", () => {
    expect(parseCliReleaseTag("cli-v0.1.2")).toBe("0.1.2");
  });

  it("rejects desktop and unversioned tags", () => {
    expect(() => parseCliReleaseTag("v0.1.2")).toThrow("cli-vX.Y.Z");
    expect(() => parseCliReleaseTag("desktop-v0.1.4")).toThrow("cli-vX.Y.Z");
    expect(() => parseCliReleaseTag("")).toThrow("cli-vX.Y.Z");
  });
});
