import { describe, expect, it } from "vitest";

import { createMemoryDatabase, SharedSkillStore } from "@lhic/memory";

import type { AppwriteRegistryClient } from "./appwrite-registry.js";
import type { SharedSkillsConfig } from "./config.js";
import type { SharedSkillCredentialStore } from "./credential-store.js";
import { SharedSkillsSyncService } from "./sync-service.js";

const config: SharedSkillsConfig = {
  enabled: true,
  endpoint: "https://cloud.appwrite.test/v1",
  projectId: "project",
  functionUrl: "https://registry.test",
  registryId: "project:https://registry.test",
};

describe("shared skill sync service", () => {
  it("syncs public records and uploads queued submissions when authenticated", async () => {
    const database = createMemoryDatabase();
    try {
      const store = new SharedSkillStore(database);
      const submitted: Record<string, unknown>[] = [];
      const client: AppwriteRegistryClient = {
        fetchSnapshot: async () => ({
          skills: [
            {
              registryId: config.registryId,
              skillId: "approved",
              version: "v1",
              name: "approved-skill",
              operationKey: "operation:search",
              fingerprint: "fingerprint",
              definition: { actions: [] },
              fastPathEligible: true,
              contentHash: "approved-hash",
              updatedAt: "2026-07-16T00:00:00.000Z",
            },
          ],
          revokedSkillIds: [],
          cursor: "cursor",
        }),
        submit: async (payload) => {
          submitted.push(payload);
        },
        login: async () => "session",
      };
      const credentials: SharedSkillCredentialStore = {
        get: async () => "session",
        set: async () => undefined,
        delete: async () => undefined,
      };
      const service = new SharedSkillsSyncService(
        config,
        store,
        client,
        credentials,
      );
      await service.publish({
        schemaVersion: "shared-skill-v1",
        name: "new-skill",
        contentHash: "submission-hash",
        operationKey: "operation:search",
        fingerprint: "fingerprint",
        templateVariables: [],
        definition: { actions: [] },
        fastPathEligible: true,
      });
      const result = await service.syncIfDue(true);
      expect(result).toMatchObject({ synced: true, uploaded: 0 });
      expect(submitted).toHaveLength(1);
      expect(service.status()).toMatchObject({
        cachedSkillCount: 1,
        pendingSubmissionCount: 0,
      });
    } finally {
      database.close();
    }
  });
});
