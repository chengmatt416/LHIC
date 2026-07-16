import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createMemoryDatabase,
  SharedSkillStore,
  SkillStore,
} from "@lhic/memory";
import {
  createSharedSkillsConfig,
  HttpAppwriteRegistryClient,
  KeyringSharedSkillCredentialStore,
  readSharedSkillsConfig,
  SharedSkillsSyncService,
  writeSharedSkillsConfig,
} from "@lhic/shared-skills";
import { builtinSkillDefinitions } from "@lhic/skills";

const defaultDatabaseFile = ".lhic/skills.sqlite";

export interface SharedCommandResult {
  enabled: boolean;
  databaseFile: string;
  cachedSkillCount?: number;
  pendingSubmissionCount?: number;
  lastSuccessAt?: string;
  lastError?: string;
  sync?: object;
  skills?: Array<Record<string, unknown>>;
}

export async function runSharedCommand(
  command: string | undefined,
  argumentsList: string[],
): Promise<SharedCommandResult> {
  const parsed = parseSharedArguments(argumentsList);
  const databaseFile = resolve(
    parsed.database ?? process.env.LHIC_MEMORY_DATABASE ?? defaultDatabaseFile,
  );
  switch (command) {
    case "enable":
      return enable(parsed, databaseFile);
    case "login":
      return login(parsed, databaseFile);
    case "disable":
      return disable(databaseFile);
    case "status":
      return status(databaseFile);
    case "sync":
      return sync(databaseFile, parsed.force);
    case "list":
      return list(databaseFile);
    default:
      throw new Error(
        "Shared command must be enable, login, disable, status, sync, or list.",
      );
  }
}

async function enable(
  parsed: ParsedSharedArguments,
  databaseFile: string,
): Promise<SharedCommandResult> {
  const config = createSharedSkillsConfig({
    endpoint: requiredOption(parsed.endpoint, "--endpoint"),
    projectId: requiredOption(parsed.project, "--project"),
    functionUrl: requiredOption(parsed.functionUrl, "--function-url"),
  });
  const email = requiredOption(parsed.email, "--email");
  const credentialStore = new KeyringSharedSkillCredentialStore();
  const client = new HttpAppwriteRegistryClient(config);
  const sessionCookie = await client.login(email);
  await credentialStore.set(config, sessionCookie);
  await writeSharedSkillsConfig(databaseFile, config);

  const runtime = await openRuntime(databaseFile, config);
  try {
    const queued = await runtime.service.backfill(runtime.skillStore);
    const synced = await runtime.service.syncIfDue(true);
    return result(databaseFile, runtime.service, {
      sync: { ...synced, queuedBackfill: queued },
    });
  } finally {
    runtime.database.close();
  }
}

async function login(
  parsed: ParsedSharedArguments,
  databaseFile: string,
): Promise<SharedCommandResult> {
  const config = await requiredConfig(databaseFile);
  const sessionCookie = await new HttpAppwriteRegistryClient(config).login(
    requiredOption(parsed.email, "--email"),
  );
  await new KeyringSharedSkillCredentialStore().set(config, sessionCookie);
  const runtime = await openRuntime(databaseFile, config);
  try {
    const synced = await runtime.service.syncIfDue(true);
    return result(databaseFile, runtime.service, { sync: synced });
  } finally {
    runtime.database.close();
  }
}

async function disable(databaseFile: string): Promise<SharedCommandResult> {
  const config = await requiredConfig(databaseFile);
  await new KeyringSharedSkillCredentialStore().delete(config);
  await writeSharedSkillsConfig(databaseFile, { ...config, enabled: false });
  return { enabled: false, databaseFile };
}

async function status(databaseFile: string): Promise<SharedCommandResult> {
  const config = await readSharedSkillsConfig(databaseFile);
  if (!config) {
    return { enabled: false, databaseFile };
  }
  const runtime = await openRuntime(databaseFile, config);
  try {
    return result(databaseFile, runtime.service);
  } finally {
    runtime.database.close();
  }
}

async function sync(
  databaseFile: string,
  force: boolean,
): Promise<SharedCommandResult> {
  const config = await requiredConfig(databaseFile);
  if (!config.enabled) {
    throw new Error(
      "Shared skills are disabled. Run lhic shared enable first.",
    );
  }
  const runtime = await openRuntime(databaseFile, config);
  try {
    const synced = await runtime.service.syncIfDue(force);
    return result(databaseFile, runtime.service, { sync: synced });
  } finally {
    runtime.database.close();
  }
}

async function list(databaseFile: string): Promise<SharedCommandResult> {
  const config = await requiredConfig(databaseFile);
  const runtime = await openRuntime(databaseFile, config);
  try {
    return result(databaseFile, runtime.service, {
      skills: runtime.sharedSkillStore
        .listApproved(config.registryId)
        .map((skill) => ({
          skillId: skill.skillId,
          name: skill.name,
          version: skill.version,
          operationKey: skill.operationKey,
          fastPathEligible: skill.fastPathEligible,
          updatedAt: skill.updatedAt,
        })),
    });
  } finally {
    runtime.database.close();
  }
}

async function openRuntime(
  databaseFile: string,
  config: ReturnType<typeof createSharedSkillsConfig>,
) {
  await mkdir(dirname(databaseFile), { recursive: true });
  const database = createMemoryDatabase(databaseFile);
  database.exec("PRAGMA journal_mode = WAL;");
  const skillStore = new SkillStore(database);
  for (const skill of builtinSkillDefinitions) {
    skillStore.preload(skill.name, skill.definition);
  }
  const sharedSkillStore = new SharedSkillStore(database);
  const service = new SharedSkillsSyncService(
    config,
    sharedSkillStore,
    new HttpAppwriteRegistryClient(config),
    new KeyringSharedSkillCredentialStore(),
  );
  return { database, skillStore, sharedSkillStore, service };
}

function result(
  databaseFile: string,
  service: SharedSkillsSyncService,
  extra: Omit<SharedCommandResult, "enabled" | "databaseFile"> = {},
): SharedCommandResult {
  return { databaseFile, ...service.status(), ...extra };
}

async function requiredConfig(databaseFile: string) {
  const config = await readSharedSkillsConfig(databaseFile);
  if (!config) {
    throw new Error(
      "Shared skills are not configured. Run lhic shared enable first.",
    );
  }
  return config;
}

interface ParsedSharedArguments {
  endpoint?: string;
  project?: string;
  functionUrl?: string;
  email?: string;
  database?: string;
  force: boolean;
}

function parseSharedArguments(argumentsList: string[]): ParsedSharedArguments {
  const parsed: ParsedSharedArguments = { force: false };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    if (argument === "--force") {
      parsed.force = true;
      continue;
    }
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    switch (argument) {
      case "--endpoint":
        parsed.endpoint = value;
        break;
      case "--project":
        parsed.project = value;
        break;
      case "--function-url":
        parsed.functionUrl = value;
        break;
      case "--email":
        parsed.email = value;
        break;
      case "--database":
        parsed.database = value;
        break;
      default:
        throw new Error(`Unknown shared skills option: ${argument}.`);
    }
    index += 1;
  }
  return parsed;
}

function requiredOption(value: string | undefined, option: string): string {
  if (!value?.trim()) {
    throw new Error(`${option} is required.`);
  }
  return value;
}
