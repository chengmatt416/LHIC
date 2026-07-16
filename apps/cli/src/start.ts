import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import { builtinSkillDefinitions } from "@lhic/skills";

const defaultMemoryDatabasePath = ".lhic/skills.sqlite";

export interface StartRuntimeResult {
  databaseFile: string;
  preloadedSkills: string[];
}

export async function startLocalRuntime(
  databaseFile = defaultMemoryDatabasePath,
): Promise<StartRuntimeResult> {
  const resolvedDatabaseFile = resolve(databaseFile);
  await mkdir(dirname(resolvedDatabaseFile), { recursive: true });
  const database = createMemoryDatabase(resolvedDatabaseFile);
  try {
    database.exec("PRAGMA journal_mode = WAL;");
    const store = new SkillStore(database);
    for (const skill of builtinSkillDefinitions) {
      store.preload(skill.name, skill.definition);
    }
    return {
      databaseFile: resolvedDatabaseFile,
      preloadedSkills: builtinSkillDefinitions.map((skill) => skill.name),
    };
  } finally {
    database.close();
  }
}
