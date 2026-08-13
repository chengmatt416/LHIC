import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UiSettingsStore, validateThemeSettings } from "./ui-settings-store.js";

describe("UiSettingsStore", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("defaults to light and atomically persists the dark theme", async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-ui-settings-"));
    const store = new UiSettingsStore(directory);

    await expect(store.load()).resolves.toEqual({ theme: "light" });
    await expect(store.save("dark")).resolves.toEqual({ theme: "dark" });
    await expect(store.load()).resolves.toEqual({ theme: "dark" });

    const path = join(directory, ".lhic", "ui-settings.json");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ theme: "dark" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects unsupported themes", () => {
    expect(() => validateThemeSettings({ theme: "system" })).toThrow(
      "UI theme is invalid.",
    );
  });
});
