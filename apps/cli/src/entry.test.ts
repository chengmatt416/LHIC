import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isEntryPoint, userCliUsage } from "./entry.js";

describe("published CLI entrypoint", () => {
  it("recognizes a package-manager symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-user-entry-"));
    const modulePath = join(directory, "entry.js");
    const binaryPath = join(directory, "lhic");
    await writeFile(modulePath, "", "utf8");
    await symlink(modulePath, binaryPath);

    expect(isEntryPoint(binaryPath, modulePath)).toBe(true);
  });

  it("documents beginner commands without removing legacy usage", () => {
    expect(userCliUsage).toContain("Usage: lhic");
    expect(userCliUsage).toContain("lhic setup");
    expect(userCliUsage).toContain("lhic doctor");
    expect(userCliUsage).toContain("lhic skills");
  });
});
