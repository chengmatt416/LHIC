import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface SharedSkillsConfig {
  enabled: boolean;
  endpoint: string;
  projectId: string;
  functionUrl: string;
  registryId: string;
}

export function sharedSkillsConfigPath(databaseFile: string): string {
  return join(dirname(resolve(databaseFile)), "shared-skills.json");
}

export async function readSharedSkillsConfig(
  databaseFile: string,
): Promise<SharedSkillsConfig | undefined> {
  try {
    const raw = await readFile(sharedSkillsConfigPath(databaseFile), "utf8");
    return parseSharedSkillsConfig(JSON.parse(raw) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeSharedSkillsConfig(
  databaseFile: string,
  config: SharedSkillsConfig,
): Promise<void> {
  const validated = parseSharedSkillsConfig(config);
  const path = sharedSkillsConfigPath(databaseFile);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function createSharedSkillsConfig(input: {
  endpoint: string;
  projectId: string;
  functionUrl: string;
  enabled?: boolean;
}): SharedSkillsConfig {
  const endpoint = normalizeUrl(input.endpoint, "Appwrite endpoint");
  const functionUrl = normalizeUrl(input.functionUrl, "Appwrite Function URL");
  const projectId = input.projectId.trim();
  if (!projectId) {
    throw new Error("Appwrite project ID must not be empty.");
  }
  return {
    enabled: input.enabled ?? true,
    endpoint,
    projectId,
    functionUrl,
    registryId: `${projectId}:${functionUrl}`,
  };
}

function parseSharedSkillsConfig(value: unknown): SharedSkillsConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Shared skills configuration must be an object.");
  }
  const record = value as Partial<SharedSkillsConfig>;
  if (typeof record.enabled !== "boolean") {
    throw new Error("Shared skills configuration enabled must be a boolean.");
  }
  return createSharedSkillsConfig({
    endpoint: requiredString(record.endpoint, "Appwrite endpoint"),
    projectId: requiredString(record.projectId, "Appwrite project ID"),
    functionUrl: requiredString(record.functionUrl, "Appwrite Function URL"),
    enabled: record.enabled,
  });
}

function normalizeUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL.`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an HTTPS URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include URL credentials.`);
  }
  return url.toString().replace(/\/$/, "");
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty.`);
  }
  return value;
}
