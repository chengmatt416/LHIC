import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSharedSkillsConfig,
  writeSharedSkillsConfig,
} from "@lhic/shared-skills";
import { describe, expect, it } from "vitest";

import { SkillsService } from "./skills-service.js";

describe("SkillsService", () => {
  it("uses the bundled public registry configuration without opening a remote connection", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-desktop-skills-"));
    try {
      const service = new SkillsService(directory, {
        databaseFile: ".lhic/test.sqlite",
      });

      await expect(service.status()).resolves.toEqual({
        configured: true,
        enabled: true,
        cachedSkillCount: 0,
        pendingSubmissionCount: 0,
        registryId:
          "lhic-shared-skills:https://lhic-shared-registry.fra.appwrite.run",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("syncs only validated approved records and creates a checksummed export", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lhic-desktop-skills-"));
    const databaseFile = join(directory, ".lhic/test.sqlite");
    try {
      const config = createSharedSkillsConfig({
        endpoint: "https://appwrite.example.test/v1",
        projectId: "project-1",
        functionUrl: "https://registry.example.test",
      });
      const service = new SkillsService(directory, {
        databaseFile,
        credentialStore: noSessionCredentialStore,
        fetchImplementation: async (input) => {
          expect(String(input)).toBe("https://registry.example.test/skills");
          return new Response(
            JSON.stringify({
              skills: [approvedRecord],
              revokedSkillIds: [],
              cursor: "registry-cursor-1",
            }),
            { status: 200 },
          );
        },
      });
      await writeSharedSkillsConfig(databaseFile, config);

      const sync = await service.sync();
      expect(sync.status).toBe("completed");
      await expect(service.list()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "approved-search",
            source: "shared",
            status: "approved",
          }),
        ]),
      );

      const output = join(directory, "approved.zip");
      await expect(service.exportApproved(output)).resolves.toEqual({
        path: output,
        count: 1,
      });
      const zip = await readFile(output);
      expect(zip.includes(Buffer.from("manifest.json"))).toBe(true);
      expect(zip.includes(Buffer.from(approvedRecord.skillId))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const noSessionCredentialStore = {
  get: async () => undefined,
  set: async () => undefined,
  delete: async () => undefined,
};

const approvedRecord = {
  skillId: "shared-search-1",
  version: "1.0.0",
  name: "approved-search",
  operationKey: "search",
  fingerprint: "search-public-v1",
  definition: { kind: "browser", version: 1 },
  fastPathEligible: true,
  contentHash: "a".repeat(64),
  updatedAt: "2026-07-18T00:00:00.000Z",
};
