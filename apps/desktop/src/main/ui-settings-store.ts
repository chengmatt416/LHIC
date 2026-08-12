import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ThemeSettings } from "../shared/contracts.js";

const settingsName = ".lhic/ui-settings.json";

const defaultSettings: ThemeSettings = { theme: "light" };

/**
 * Stores only lightweight UI preferences (currently the Neomorphism theme).
 * Nothing sensitive ever lives here; credentials and approvals stay in the OS
 * Keychain and their dedicated stores.
 */
export class UiSettingsStore {
  private readonly path: string;

  public constructor(workspaceRoot: string) {
    this.path = resolve(workspaceRoot, settingsName);
  }

  public async load(): Promise<ThemeSettings> {
    try {
      return validateThemeSettings(
        JSON.parse(await readFile(this.path, "utf8")) as unknown,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...defaultSettings };
      }
      throw error;
    }
  }

  public async save(theme: ThemeSettings["theme"]): Promise<ThemeSettings> {
    const settings: ThemeSettings = { theme: validateTheme(theme) };
    const content = `${JSON.stringify(settings, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
    return settings;
  }
}

export function validateThemeSettings(value: unknown): ThemeSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("UI settings are invalid.");
  }
  return { theme: validateTheme((value as ThemeSettings).theme) };
}

function validateTheme(value: unknown): ThemeSettings["theme"] {
  if (value === "light" || value === "dark") {
    return value;
  }
  throw new Error("UI theme is invalid.");
}
