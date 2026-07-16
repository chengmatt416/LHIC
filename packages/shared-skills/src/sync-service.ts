import type { DatabaseSync } from "node:sqlite";

import {
  createLegacySharedSkillPublication,
  type SharedSkillPublication,
  type SharedSkillPublisher,
} from "@lhic/controller";
import {
  SharedSkillStore,
  type SkillStore,
  type SharedSkillSyncState,
} from "@lhic/memory";

import {
  HttpAppwriteRegistryClient,
  type AppwriteRegistryClient,
} from "./appwrite-registry.js";
import {
  KeyringSharedSkillCredentialStore,
  type SharedSkillCredentialStore,
} from "./credential-store.js";
import { readSharedSkillsConfig, type SharedSkillsConfig } from "./config.js";

const syncIntervalMs = 24 * 60 * 60 * 1_000;

export interface SharedSkillsRuntimeStatus {
  enabled: boolean;
  cachedSkillCount: number;
  pendingSubmissionCount: number;
  lastSuccessAt?: string;
  lastError?: string;
}

export interface SharedSkillsSyncResult {
  attempted: boolean;
  synced: boolean;
  uploaded: number;
  pendingSubmissionCount: number;
  lastError?: string;
}

export class SharedSkillsSyncService implements SharedSkillPublisher {
  public constructor(
    private readonly config: SharedSkillsConfig,
    private readonly store: SharedSkillStore,
    private readonly client: AppwriteRegistryClient,
    private readonly credentialStore: SharedSkillCredentialStore,
  ) {}

  public async publish(publication: SharedSkillPublication): Promise<void> {
    this.store.enqueueSubmission(
      this.config.registryId,
      publication.contentHash,
      publication,
    );
    await this.flushOutbox();
  }

  public async syncIfDue(force = false): Promise<SharedSkillsSyncResult> {
    const state = this.store.getSyncState(this.config.registryId);
    if (!force && !isDue(state)) {
      return this.result(false, false, 0);
    }
    try {
      const snapshot = await this.client.fetchSnapshot();
      this.store.applySnapshot(this.config.registryId, snapshot);
      this.store.recordSyncSuccess(this.config.registryId, snapshot.cursor);
      const uploaded = await this.flushOutbox();
      return this.result(true, true, uploaded);
    } catch (error) {
      this.store.recordSyncFailure(
        this.config.registryId,
        error instanceof Error ? error.message : String(error),
      );
      return this.result(true, false, 0);
    }
  }

  public async backfill(skillStore: SkillStore): Promise<number> {
    let queued = 0;
    for (const skill of skillStore.list(1_000)) {
      const publication = createLegacySharedSkillPublication(skill);
      if (
        publication &&
        this.store.enqueueSubmission(
          this.config.registryId,
          publication.contentHash,
          publication,
        )
      ) {
        queued += 1;
      }
    }
    await this.flushOutbox();
    return queued;
  }

  public status(): SharedSkillsRuntimeStatus {
    const state = this.store.getSyncState(this.config.registryId);
    return {
      enabled: this.config.enabled,
      cachedSkillCount: this.store.listApproved(this.config.registryId).length,
      pendingSubmissionCount: this.store.listOutbox(this.config.registryId)
        .length,
      ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  private async flushOutbox(): Promise<number> {
    const sessionCookie = await this.credentialStore.get(this.config);
    if (!sessionCookie) {
      return 0;
    }
    let uploaded = 0;
    for (const entry of this.store.listOutbox(this.config.registryId)) {
      try {
        await this.client.submit(entry.payload, sessionCookie);
        this.store.acknowledgeSubmission(entry.id);
        uploaded += 1;
      } catch (error) {
        this.store.recordSubmissionFailure(entry.id);
        this.store.recordSyncFailure(
          this.config.registryId,
          error instanceof Error ? error.message : String(error),
        );
        break;
      }
    }
    return uploaded;
  }

  private result(
    attempted: boolean,
    synced: boolean,
    uploaded: number,
  ): SharedSkillsSyncResult {
    const state = this.store.getSyncState(this.config.registryId);
    return {
      attempted,
      synced,
      uploaded,
      pendingSubmissionCount: this.store.listOutbox(this.config.registryId)
        .length,
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }
}

export interface ConfiguredSharedSkillsRuntime {
  config: SharedSkillsConfig;
  store: SharedSkillStore;
  service: SharedSkillsSyncService;
  sync: SharedSkillsSyncResult;
}

export async function createConfiguredSharedSkillsRuntime(
  database: DatabaseSync,
  databaseFile: string,
): Promise<ConfiguredSharedSkillsRuntime | undefined> {
  const config = await readSharedSkillsConfig(databaseFile);
  if (!config?.enabled) {
    return undefined;
  }
  const store = new SharedSkillStore(database);
  const service = new SharedSkillsSyncService(
    config,
    store,
    new HttpAppwriteRegistryClient(config),
    new KeyringSharedSkillCredentialStore(),
  );
  return { config, store, service, sync: await service.syncIfDue() };
}

function isDue(state: SharedSkillSyncState): boolean {
  if (!state.lastSuccessAt) {
    return true;
  }
  const lastSuccess = Date.parse(state.lastSuccessAt);
  return (
    Number.isNaN(lastSuccess) || Date.now() - lastSuccess >= syncIntervalMs
  );
}
