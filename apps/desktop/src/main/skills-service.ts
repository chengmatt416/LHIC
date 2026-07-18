import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
  type SharedSkillsConfig,
  type SharedSkillCredentialStore,
} from "@lhic/shared-skills";
import { builtinSkillDefinitions } from "@lhic/skills";

import type {
  CommandEvent,
  PublicWebTrainingRequest,
  SharedLibraryConnection,
  SharedLibraryStatus,
  SkillSummary,
  TrainingJob,
} from "../shared/contracts.js";
import { bakedSharedSkillsConfig } from "./appwrite-public-config.js";
import { PublicWebTrainingService } from "./public-web-training-service.js";
import { createZip } from "./zip.js";

const defaultDatabaseFile = ".lhic/skills.sqlite";

interface SkillsServiceOptions {
  databaseFile?: string;
  fetchImplementation?: typeof fetch;
  credentialStore?: SharedSkillCredentialStore;
}

interface SharedRuntime {
  config: SharedSkillsConfig;
  database: ReturnType<typeof createMemoryDatabase>;
  store: SharedSkillStore;
  service: SharedSkillsSyncService;
}

/**
 * Owns the desktop's local shared-Skill mirror. Appwrite session cookies remain
 * in the OS Keychain; this service only exposes status and approved artifacts.
 */
export class SkillsService {
  private readonly databaseFile: string;
  private readonly credentialStore: SharedSkillCredentialStore;
  private readonly publicWebTraining: PublicWebTrainingService;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly options: SkillsServiceOptions = {},
  ) {
    this.databaseFile = resolve(
      workspaceRoot,
      options.databaseFile ?? defaultDatabaseFile,
    );
    this.credentialStore =
      options.credentialStore ?? new KeyringSharedSkillCredentialStore();
    this.publicWebTraining = new PublicWebTrainingService(workspaceRoot);
  }

  public startPublicWebTraining(
    input: PublicWebTrainingRequest,
  ): Promise<TrainingJob> {
    return this.publicWebTraining.start(input);
  }

  public publicWebTrainingStatus(id: string): TrainingJob {
    return this.publicWebTraining.status(id);
  }

  public subscribePublicWebTraining(
    listener: (job: TrainingJob) => void,
  ): () => void {
    return this.publicWebTraining.subscribe(listener);
  }

  public cancelPublicWebTraining(id: string): Promise<void> {
    return this.publicWebTraining.cancel(id);
  }

  public async list(): Promise<SkillSummary[]> {
    const config = await this.config();
    if (!config?.enabled) return builtinSkills();
    const runtime = await this.openRuntime(config);
    try {
      return [
        ...builtinSkills(),
        ...runtime.store.listApproved(config.registryId).map((skill) => ({
          name: skill.name,
          source: "shared" as const,
          version: skill.version,
          status: "approved" as const,
          fastPathEligible: skill.fastPathEligible,
          updatedAt: skill.updatedAt,
        })),
      ];
    } finally {
      runtime.database.close();
    }
  }

  public async status(): Promise<SharedLibraryStatus> {
    const config = await this.config();
    if (!config) {
      return {
        configured: false,
        enabled: false,
        cachedSkillCount: 0,
        pendingSubmissionCount: 0,
      };
    }
    const runtime = await this.openRuntime(config);
    try {
      const status = runtime.service.status();
      return {
        configured: true,
        ...status,
        ...(config.registryId ? { registryId: config.registryId } : {}),
        ...(status.lastError ? { lastError: safeError(status.lastError) } : {}),
      };
    } finally {
      runtime.database.close();
    }
  }

  public async connect(input: SharedLibraryConnection): Promise<CommandEvent> {
    const config = validateSharedConfig(input);
    await writeSharedSkillsConfig(this.databaseFile, config);
    const sessionCookie = await this.client(config).login(input.email);
    await this.credentialStore.set(config, sessionCookie);
    const runtime = await this.openRuntime(config);
    try {
      const queuedBackfill = await runtime.service.backfill(
        this.localSkillStore(runtime.database),
      );
      const sync = await runtime.service.syncIfDue(true);
      if (!sync.synced) {
        throw new Error(
          sync.lastError ?? "Shared Skill sync was not accepted.",
        );
      }
      return completedEvent(
        "Shared Skill library connected and synchronised.",
        [
          "Magic Link session is stored only in the OS Keychain.",
          `Queued ${queuedBackfill} verified local candidate${queuedBackfill === 1 ? "" : "s"} for the pending review queue.`,
          `Downloaded ${runtime.store.listApproved(config.registryId).length} approved shared Skill${runtime.store.listApproved(config.registryId).length === 1 ? "" : "s"}.`,
        ],
      );
    } finally {
      runtime.database.close();
    }
  }

  public async login(email: string): Promise<CommandEvent> {
    const config = await this.requiredEnabledConfig();
    const sessionCookie = await this.client(config).login(email);
    await this.credentialStore.set(config, sessionCookie);
    return completedEvent("Shared Skill Magic Link sign-in completed.", [
      "The session cookie is stored only in the OS Keychain.",
    ]);
  }

  public async sync(): Promise<CommandEvent> {
    const config = await this.requiredEnabledConfig();
    const runtime = await this.openRuntime(config);
    try {
      const queuedBackfill = await runtime.service.backfill(
        this.localSkillStore(runtime.database),
      );
      const sync = await runtime.service.syncIfDue(true);
      if (!sync.synced) {
        return failedEvent(
          sync.lastError ?? "Shared Skill sync did not complete.",
        );
      }
      const status = runtime.service.status();
      return completedEvent("Shared Skill library synchronised.", [
        `Approved mirror contains ${status.cachedSkillCount} Skill${status.cachedSkillCount === 1 ? "" : "s"}.`,
        `Queued ${queuedBackfill} newly verified local candidate${queuedBackfill === 1 ? "" : "s"} for review.`,
        `Submitted ${sync.uploaded} verified candidate${sync.uploaded === 1 ? "" : "s"} to the pending review queue.`,
        `Pending local submissions: ${status.pendingSubmissionCount}.`,
      ]);
    } finally {
      runtime.database.close();
    }
  }

  public async exportApproved(
    destination: string,
  ): Promise<{ path: string; count: number }> {
    const config = await this.requiredEnabledConfig();
    const runtime = await this.openRuntime(config);
    try {
      const entries = runtime.store
        .listApproved(config.registryId)
        .sort((left, right) => left.skillId.localeCompare(right.skillId))
        .map((skill) => {
          const fileName = `skills/${safeName(skill.skillId)}.json`;
          const content = `${JSON.stringify(skill, null, 2)}\n`;
          return { fileName, content, sha256: digest(content) };
        });
      const manifest = {
        schemaVersion: "lhic-shared-skills-export-v1",
        exportedAt: new Date().toISOString(),
        registryId: config.registryId,
        skills: entries.map(({ fileName, sha256 }) => ({ fileName, sha256 })),
      };
      const output = resolve(destination);
      if (!output.endsWith(".zip")) {
        throw new Error("Shared Skill exports must use a .zip destination.");
      }
      await mkdir(dirname(output), { recursive: true });
      const zip = createZip([
        {
          name: "manifest.json",
          content: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
        },
        ...entries.map((entry) => ({
          name: entry.fileName,
          content: Buffer.from(entry.content),
        })),
      ]);
      await writeFile(output, zip, { flag: "wx", mode: 0o600 });
      return { path: output, count: entries.length };
    } finally {
      runtime.database.close();
    }
  }

  private async config(): Promise<SharedSkillsConfig | undefined> {
    const config =
      (await readSharedSkillsConfig(this.databaseFile)) ??
      bakedSharedSkillsConfig;
    return validateSharedConfig(config);
  }

  private async requiredEnabledConfig(): Promise<SharedSkillsConfig> {
    const config = await this.config();
    if (!config?.enabled) {
      throw new Error(
        "Shared Skills are not connected. Complete Magic Link sign-in first.",
      );
    }
    return config;
  }

  private async openRuntime(
    config: SharedSkillsConfig,
  ): Promise<SharedRuntime> {
    await mkdir(dirname(this.databaseFile), { recursive: true });
    const database = createMemoryDatabase(this.databaseFile);
    database.exec("PRAGMA journal_mode = WAL;");
    const store = new SharedSkillStore(database);
    return {
      config,
      database,
      store,
      service: new SharedSkillsSyncService(
        config,
        store,
        this.client(config),
        this.credentialStore,
      ),
    };
  }

  private localSkillStore(
    database: ReturnType<typeof createMemoryDatabase>,
  ): SkillStore {
    const store = new SkillStore(database);
    for (const skill of builtinSkillDefinitions) {
      store.preload(skill.name, skill.definition);
    }
    return store;
  }

  private client(config: SharedSkillsConfig): HttpAppwriteRegistryClient {
    return new HttpAppwriteRegistryClient(config, {
      ...(this.options.fetchImplementation
        ? { fetchImplementation: this.options.fetchImplementation }
        : {}),
    });
  }
}

function validateSharedConfig(
  input: Pick<
    SharedLibraryConnection,
    "endpoint" | "projectId" | "functionUrl"
  > & { enabled?: boolean },
): SharedSkillsConfig {
  const config = createSharedSkillsConfig(input);
  for (const [label, value] of [
    ["Appwrite endpoint", config.endpoint],
    ["Appwrite Function URL", config.functionUrl],
  ] as const) {
    const url = new URL(value);
    if (url.username || url.password) {
      throw new Error(`${label} must not include URL credentials.`);
    }
  }
  return config;
}

function completedEvent(message: string, evidence: string[]): CommandEvent {
  return {
    commandId: `shared-${Date.now()}`,
    status: "completed",
    message,
    createdAt: new Date().toISOString(),
    evidence,
  };
}

function failedEvent(message: string): CommandEvent {
  return {
    commandId: `shared-${Date.now()}`,
    status: "failed",
    message: safeError(message),
    createdAt: new Date().toISOString(),
  };
}

function builtinSkills(): SkillSummary[] {
  return builtinSkillDefinitions.map((skill) => ({
    name: skill.name,
    source: "builtin" as const,
    status: "ready" as const,
    fastPathEligible: true,
  }));
}

function safeError(value: string): string {
  return value
    .replace(
      /\b(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,}\b/gi,
      "[REDACTED_TOKEN]",
    )
    .slice(0, 1_000);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}
