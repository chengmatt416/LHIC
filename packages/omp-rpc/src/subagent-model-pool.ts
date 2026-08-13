import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export interface OmpModelCatalogEntry {
  provider: string;
  id: string;
  displayName?: string;
  reasoning?: boolean;
  image?: boolean;
  contextWindow?: number;
  thinkingLevels?: string[];
}

export interface OmpSubagentModel {
  selector: string;
  provider: string;
  modelId: string;
  agentName: string;
  connected: true;
  reasoning?: boolean;
  image?: boolean;
  contextWindow?: number;
  thinkingLevels?: string[];
}

export interface GeneratedModelPool {
  extensionRoot: string;
  models: OmpSubagentModel[];
}

/**
 * Generates a private OMP extension containing one non-recursive task agent
 * for each explicitly enabled, currently connected model.
 */
export class SubagentModelPool {
  public constructor(private readonly extensionRoot: string) {}

  public async generate(
    catalog: OmpModelCatalogEntry[],
    enabledSelectors: string[],
  ): Promise<GeneratedModelPool> {
    const models = reconcileSubagentModels(catalog, enabledSelectors);
    const parent = dirname(this.extensionRoot);
    const name = basename(this.extensionRoot);
    const temporary = join(
      parent,
      `.${name}.${process.pid}.${Date.now().toString(36)}.tmp`,
    );
    const backup = `${this.extensionRoot}.${process.pid}.bak`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(join(temporary, "agents"), { recursive: true, mode: 0o700 });
    for (const model of models) {
      await writeFile(
        join(temporary, "agents", `${model.agentName}.md`),
        agentDefinition(model),
        { encoding: "utf8", mode: 0o600 },
      );
    }
    await writeFile(
      join(temporary, "model-pool.json"),
      `${JSON.stringify(
        {
          schemaVersion: "lhic-omp-model-pool-v1",
          selectors: models.map((model) => model.selector),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await rm(backup, { recursive: true, force: true });
    try {
      await rename(this.extensionRoot, backup);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(temporary, this.extensionRoot);
      await rm(backup, { recursive: true, force: true });
    } catch (error) {
      await rm(this.extensionRoot, { recursive: true, force: true });
      try {
        await rename(backup, this.extensionRoot);
      } catch {
        // If no prior pool existed, there is nothing to restore.
      }
      throw error;
    }
    return { extensionRoot: this.extensionRoot, models };
  }
}

export function parseModelCatalog(
  payload: Record<string, unknown>,
): OmpModelCatalogEntry[] {
  const raw = Array.isArray(payload.models) ? payload.models : [];
  const models: OmpModelCatalogEntry[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const capabilities =
      record.capabilities &&
      typeof record.capabilities === "object" &&
      !Array.isArray(record.capabilities)
        ? (record.capabilities as Record<string, unknown>)
        : {};
    const thinking =
      record.thinking &&
      typeof record.thinking === "object" &&
      !Array.isArray(record.thinking)
        ? (record.thinking as Record<string, unknown>)
        : {};
    const provider = String(record.provider ?? record.providerId ?? "");
    const id = String(record.modelId ?? record.id ?? "");
    if (!provider || !id) continue;
    const model: OmpModelCatalogEntry = { provider, id };
    const displayName = record.name ?? record.displayName;
    if (typeof displayName === "string") {
      model.displayName = displayName;
    }
    const reasoning = booleanCapability(record, capabilities, "reasoning");
    if (reasoning !== undefined) model.reasoning = reasoning;
    const image = Array.isArray(record.input)
      ? record.input.includes("image")
      : booleanCapability(record, capabilities, "image");
    if (image !== undefined) model.image = image;
    const contextWindow = numberCapability(
      record,
      capabilities,
      "contextWindow",
    );
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    const thinkingLevels = Array.isArray(thinking.efforts)
      ? thinking.efforts
      : Array.isArray(record.thinkingLevels)
        ? record.thinkingLevels
        : Array.isArray(capabilities.thinkingLevels)
          ? capabilities.thinkingLevels
          : undefined;
    if (thinkingLevels) {
      model.thinkingLevels = thinkingLevels.filter(
        (level): level is string => typeof level === "string",
      );
    }
    models.push(model);
  }
  return models;
}

export function reconcileSubagentModels(
  catalog: OmpModelCatalogEntry[],
  enabledSelectors: string[],
): OmpSubagentModel[] {
  const bySelector = new Map(
    catalog.map((model) => [`${model.provider}/${model.id}`, model]),
  );
  const unique = [...new Set(enabledSelectors)];
  return unique.map((selector) => {
    validateModelSelector(selector);
    const model = bySelector.get(selector);
    if (!model) {
      throw new Error(`Subagent model ${selector} is not connected.`);
    }
    return {
      selector,
      provider: model.provider,
      modelId: model.id,
      agentName: agentNameFor(selector),
      connected: true,
      ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
      ...(model.image !== undefined ? { image: model.image } : {}),
      ...(model.contextWindow !== undefined
        ? { contextWindow: model.contextWindow }
        : {}),
      ...(model.thinkingLevels
        ? { thinkingLevels: [...model.thinkingLevels] }
        : {}),
    };
  });
}

export function connectedSelectors(
  catalog: OmpModelCatalogEntry[],
  persistedSelectors: string[],
): string[] {
  const connected = new Set(
    catalog.map((model) => `${model.provider}/${model.id}`),
  );
  return [...new Set(persistedSelectors)].filter(
    (selector) => isValidModelSelector(selector) && connected.has(selector),
  );
}

export function validateModelSelector(selector: string): void {
  if (!isValidModelSelector(selector)) {
    throw new Error(`Invalid subagent model selector: ${selector}.`);
  }
}

function isValidModelSelector(selector: string): boolean {
  if (selector.length < 3 || selector.length > 200) return false;
  const slash = selector.indexOf("/");
  if (slash < 1 || slash === selector.length - 1) return false;
  const provider = selector.slice(0, slash);
  const model = selector.slice(slash + 1);
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider) &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model) &&
    !model.includes("..") &&
    !model.endsWith("/")
  );
}

function agentNameFor(selector: string): string {
  const slug = selector
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const digest = createHash("sha256")
    .update(selector)
    .digest("hex")
    .slice(0, 8);
  return `model-${slug || "worker"}-${digest}`;
}

function agentDefinition(model: OmpSubagentModel): string {
  const capabilities = [
    model.reasoning ? "reasoning" : undefined,
    model.image ? "image input" : undefined,
    model.contextWindow ? `${model.contextWindow} token context` : undefined,
    model.thinkingLevels?.length
      ? `thinking levels ${model.thinkingLevels.join(", ")}`
      : undefined,
  ].filter(Boolean);
  const capabilityText = capabilities.length
    ? ` Capabilities: ${capabilities.join("; ")}.`
    : "";
  return `---\nname: ${model.agentName}\ndescription: Route suitable independent work to ${model.selector}.${capabilityText}\nmodel: "${model.selector}"\ntools: read, grep, glob, bash, edit, write, web_search\nspawns: []\n---\n\nComplete the assigned task with the selected model. Do not delegate or spawn subagents. Report the concrete result, verification, and blockers to the parent.\n`;
}

function booleanCapability(
  model: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  name: string,
): boolean | undefined {
  const direct = model[name] ?? model[`supports${capitalize(name)}`];
  const nested =
    capabilities[name] ?? capabilities[`supports${capitalize(name)}`];
  if (typeof direct === "boolean") return direct;
  return typeof nested === "boolean" ? nested : undefined;
}

function numberCapability(
  model: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = model[name] ?? capabilities[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
