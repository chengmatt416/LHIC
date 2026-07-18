import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSharedSkillsConfig,
  writeSharedSkillsConfig,
} from "@lhic/shared-skills";
import { describe, expect, it } from "vitest";

import { ControlPlaneClient } from "./control-plane-client.js";

describe("ControlPlaneClient", () => {
  it("uses a short-lived JWT to retrieve only allowlisted judge evidence", async () => {
    const directory = await configuredWorkspace();
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    try {
      const client = new ControlPlaneClient(directory, {
        credentialStore: sessionCredentialStore,
        fetchImplementation: async (input, init) => {
          calls.push({ url: String(input), headers: init?.headers });
          if (String(input).endsWith("/account/jwt")) {
            return json({ jwt: "short-lived-jwt" });
          }
          if (String(input).endsWith("/control/judge/session")) {
            return json({
              githubUserId: "123456",
              subject: "GitHub numeric-ID allowlist",
              authentication: "github",
              allowed: true,
            });
          }
          if (String(input).endsWith("/control/judge/catalog")) {
            return json({ assets: [judgeAsset] });
          }
          throw new Error(`Unexpected request ${String(input)}`);
        },
      });

      await expect(client.judgeSession()).resolves.toEqual({
        githubUserId: "123456",
        subject: "GitHub numeric-ID allowlist",
        authentication: "github",
        allowed: true,
      });
      await expect(client.judgeCatalog()).resolves.toEqual([judgeAsset]);

      expect(calls).toHaveLength(4);
      expect(calls[1]?.headers).toMatchObject({
        "X-Appwrite-User-JWT": "short-lived-jwt",
      });
      expect(calls[1]?.headers).not.toMatchObject({
        Cookie: "session-cookie-only-in-test",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("opens the Appwrite GitHub OAuth device flow without returning its device code", async () => {
    const directory = await configuredWorkspace();
    const opened: string[] = [];
    try {
      const client = new ControlPlaneClient(directory, {
        openExternal: async (url) => {
          opened.push(url);
        },
      });

      const state = await client.beginGithubLogin();

      expect(state.status).toBe("pending");
      expect(opened).toHaveLength(1);
      const oauth = new URL(opened[0]!);
      expect(oauth.pathname).toBe("/v1/account/sessions/oauth2/github");
      expect(oauth.searchParams.get("project")).toBe("project-1");
      expect(oauth.searchParams.get("success")).toContain(
        "https://registry.example.test/auth/callback?device=",
      );
      expect(JSON.stringify(state)).not.toContain("device=");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stores an issued judge token in Keychain and uses it instead of a shared-library cookie", async () => {
    const directory = await configuredWorkspace();
    const stored: string[] = [];
    const calls: Array<{ url: string; headers?: HeadersInit }> = [];
    try {
      const client = new ControlPlaneClient(directory, {
        credentialStore: sessionCredentialStore,
        judgeTokenStore: {
          get: async () => undefined,
          set: async (_id, value) => stored.push(value),
        },
        fetchImplementation: async (input, init) => {
          calls.push({ url: String(input), headers: init?.headers });
          if (String(input).endsWith("/control/judge/session")) {
            return json({
              subject: "Issued token: Hackathon judge",
              authentication: "token",
              allowed: true,
            });
          }
          throw new Error(`Unexpected request ${String(input)}`);
        },
      });

      const token = `lhic_judge_${"a".repeat(43)}`;
      await expect(client.authorizeJudgeToken(token)).resolves.toMatchObject({
        authentication: "token",
        allowed: true,
      });

      expect(stored).toEqual([token]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.headers).toMatchObject({
        "X-LHIC-Judge-Token": token,
      });
      expect(calls[0]?.headers).not.toMatchObject({
        "X-Appwrite-User-JWT": expect.anything(),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns administrator metadata without credential plaintext", async () => {
    const directory = await configuredWorkspace();
    try {
      const client = new ControlPlaneClient(directory, {
        credentialStore: sessionCredentialStore,
        fetchImplementation: async (input) => {
          const url = String(input);
          if (url.endsWith("/account/jwt")) return json({ jwt: "admin-jwt" });
          if (url.endsWith("/control/session")) {
            return json({ accountId: "admin-account", admin: true });
          }
          if (url.endsWith("/control/judges")) {
            return json({
              judges: [
                {
                  id: "judge-1",
                  kind: "github-user-id",
                  githubUserId: "123456",
                  label: "Primary judge",
                  active: true,
                },
              ],
            });
          }
          if (url.endsWith("/control/judge-tokens")) {
            return json({ tokens: [] });
          }
          if (url.endsWith("/control/skills")) {
            return json({
              skills: [
                {
                  id: "skill-1",
                  name: "search",
                  version: "v1",
                  status: "pending",
                  fastPathEligible: false,
                  updatedAt: "2026-07-18T00:00:00.000Z",
                },
              ],
            });
          }
          if (url.endsWith("/control/demo-keys")) {
            return json({ keys: [] });
          }
          if (url.endsWith("/control/secrets")) {
            return json({
              secrets: [
                {
                  id: "secret-1",
                  label: "Registry credential",
                  kind: "appwrite",
                  keyVersion: "v1",
                  createdAt: "2026-07-18T00:00:00.000Z",
                },
              ],
            });
          }
          if (url.endsWith("/control/assets"))
            return json({ assets: [judgeAsset] });
          if (url.endsWith("/control/policy-packages")) {
            return json({ policyPackages: [] });
          }
          throw new Error(`Unexpected request ${url}`);
        },
      });

      const snapshot = await client.adminSnapshot();

      expect(snapshot.session.accountId).toBe("admin-account");
      expect(snapshot.secrets).toEqual([
        expect.objectContaining({
          label: "Registry credential",
          kind: "appwrite",
        }),
      ]);
      expect(snapshot.policyPackages).toEqual([]);
      expect(JSON.stringify(snapshot)).not.toContain(
        "session-cookie-only-in-test",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("submits only verified policy metadata and never local file paths", async () => {
    const directory = await configuredWorkspace();
    let requestBody = "";
    try {
      const client = new ControlPlaneClient(directory, {
        credentialStore: sessionCredentialStore,
        fetchImplementation: async (input, init) => {
          const url = String(input);
          if (url.endsWith("/account/jwt")) return json({ jwt: "member-jwt" });
          if (url.endsWith("/control/policy-packages")) {
            requestBody = String(init?.body ?? "");
            return json({
              policyPackage: {
                id: "policy-1",
                packageId: "a".repeat(64),
                core: "2d",
                profileId: "star-trooper",
                bundleUrl: "https://packages.example.test/policy.zip",
                bundleSha256: "b".repeat(64),
                manifestSha256: "c".repeat(64),
                weightsSha256: "d".repeat(64),
                actionCodec: "game-2d-action-v1",
                version: "v1",
                status: "pending",
                createdAt: "2026-07-18T00:00:00.000Z",
                updatedAt: "2026-07-18T00:00:00.000Z",
              },
            });
          }
          throw new Error(`Unexpected request ${url}`);
        },
      });

      const submitted = await client.submitPolicyPackage({
        package: {
          packageId: "a".repeat(64),
          core: "2d",
          profileId: "star-trooper",
          artifactPath: "/private/game/artifact.json",
          manifestPath: "/private/game/policy-package.json",
          bundlePath: "/private/game/policy-package.zip",
          reportPath: "/private/game/evaluation-report.json",
          actionCodec: "game-2d-action-v1",
          weightsSha256: "d".repeat(64),
          manifestSha256: "c".repeat(64),
          bundleSha256: "b".repeat(64),
          status: "local",
          createdAt: "2026-07-18T00:00:00.000Z",
        },
        bundleUrl: "https://packages.example.test/policy.zip",
        version: "v1",
      });

      expect(submitted).toMatchObject({ id: "policy-1", status: "pending" });
      expect(requestBody).not.toContain("/private/game");
      expect(JSON.parse(requestBody)).toMatchObject({
        packageId: "a".repeat(64),
        bundleSha256: "b".repeat(64),
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function configuredWorkspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lhic-control-plane-"));
  await writeSharedSkillsConfig(
    join(directory, ".lhic/skills.sqlite"),
    createSharedSkillsConfig({
      endpoint: "https://appwrite.example.test/v1",
      projectId: "project-1",
      functionUrl: "https://registry.example.test",
    }),
  );
  return directory;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

const sessionCredentialStore = {
  get: async () => "session-cookie-only-in-test",
  set: async () => undefined,
  delete: async () => undefined,
};

const judgeAsset = {
  id: "benchmark-1",
  title: "Browser benchmark report",
  kind: "benchmark" as const,
  sourceUrl: "https://assets.example.test/benchmark.json",
  generatedAt: "2026-07-18T00:00:00.000Z",
  sha256: "b".repeat(64),
  metadata: { suite: "browser" },
  createdAt: "2026-07-18T00:05:00.000Z",
};
