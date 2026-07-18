import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { TaskSourceConfig } from "../shared/contracts.js";
import { validateTaskSourceConfig } from "../shared/policy.js";

const configName = ".lhic/task-sources.json";

/** Persists source metadata only. API keys are always held by Keychain. */
export class TaskSourceStore {
  private readonly path: string;

  public constructor(workspaceRoot: string) {
    this.path = resolve(workspaceRoot, configName);
  }

  public async load(): Promise<TaskSourceConfig[]> {
    try {
      const raw = await readFile(this.path, "utf8");
      const value = JSON.parse(raw) as unknown;
      if (!Array.isArray(value)) {
        return [];
      }
      return value.flatMap((source) => {
        try {
          return [validateTaskSourceConfig(source as TaskSourceConfig)];
        } catch {
          // A stale source must never prevent the local control surface from
          // loading. It remains on disk for the user to inspect or replace.
          return [];
        }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      if (error instanceof SyntaxError) return [];
      throw error;
    }
  }

  public async save(sources: readonly TaskSourceConfig[]): Promise<void> {
    const content = `${JSON.stringify(sources, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
