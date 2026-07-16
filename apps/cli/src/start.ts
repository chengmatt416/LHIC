import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createMemoryDatabase, SkillStore } from "@lhic/memory";
import { createConfiguredSharedSkillsRuntime } from "@lhic/shared-skills";
import { builtinSkillDefinitions } from "@lhic/skills";

const defaultMemoryDatabasePath = ".lhic/skills.sqlite";

export interface StartRuntimeResult {
  databaseFile: string;
  preloadedSkills: string[];
  sharedSkills?: {
    enabled: boolean;
    cachedSkillCount: number;
    pendingSubmissionCount: number;
    lastSuccessAt?: string;
    lastError?: string;
  };
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
    const sharedSkills = await createConfiguredSharedSkillsRuntime(
      database,
      resolvedDatabaseFile,
    );
    return {
      databaseFile: resolvedDatabaseFile,
      preloadedSkills: builtinSkillDefinitions.map((skill) => skill.name),
      ...(sharedSkills ? { sharedSkills: sharedSkills.service.status() } : {}),
    };
  } finally {
    database.close();
  }
}
