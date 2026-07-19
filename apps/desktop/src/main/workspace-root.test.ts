import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDesktopWorkspaceRoot } from "./workspace-root.js";

describe("resolveDesktopWorkspaceRoot", () => {
  it("uses a configured workspace root when explicitly provided", () => {
    expect(
      resolveDesktopWorkspaceRoot({
        cwd: "/",
        environmentWorkspaceRoot: "/Users/operator/lhic-workspace",
        isPackaged: true,
        userData:
          "/Users/operator/Library/Application Support/LHIC Control Center",
      }),
    ).toBe("/Users/operator/lhic-workspace");
  });

  it("keeps packaged application state in Electron userData", () => {
    const userData =
      "/Users/operator/Library/Application Support/LHIC Control Center";
    expect(
      resolveDesktopWorkspaceRoot({
        cwd: "/",
        isPackaged: true,
        userData,
      }),
    ).toBe(join(userData, "workspace"));
  });

  it("uses the repository working directory during development", () => {
    expect(
      resolveDesktopWorkspaceRoot({
        cwd: "/Users/operator/Projects/LHIC",
        isPackaged: false,
        userData:
          "/Users/operator/Library/Application Support/LHIC Control Center",
      }),
    ).toBe("/Users/operator/Projects/LHIC");
  });
});
