import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";

import {
  createDemoApiKey,
  encryptSecret,
  handleControlPlane,
  validateGithubUserId,
} from "./control-plane.js";

describe("shared-skills control plane primitives", () => {
  it("uses immutable numeric GitHub ids and hashes demo key material", () => {
    expect(validateGithubUserId("123456789")).toBe("123456789");
    expect(() => validateGithubUserId("octocat")).toThrow("numeric");
    const key = createDemoApiKey();
    expect(key.value).toMatch(/^lhic_demo_/);
    expect(key.hash).toHaveLength(64);
    expect(key.hash).not.toContain(key.value);
  });

  it("returns an authenticated encryption envelope without plaintext", () => {
    const secret = "shared-library-secret";
    const envelope = encryptSecret(secret, Buffer.alloc(32, 9));
    expect(envelope.algorithm).toBe("aes-256-gcm");
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });

  it("lets the bootstrap admin grant a numeric judge identity without exposing secret payloads", async () => {
    const tables = new FakeTables();
    const res = responseCapture();
    const config = testConfig();
    await handleControlPlane({
      req: { body: JSON.stringify({ githubUserId: "42", label: "Judge" }) },
      res,
      path: new URL("https://function.test/control/judges"),
      method: "POST",
      tables,
      config,
      user: { $id: "bootstrap" },
      githubUserId: async () => "42",
    });
    expect(res.value).toMatchObject({ githubUserId: "42", active: true });

    const judgeSession = responseCapture();
    await handleControlPlane({
      req: { body: "" },
      res: judgeSession,
      path: new URL("https://function.test/control/judge/session"),
      method: "GET",
      tables,
      config,
      user: { $id: "judge-account" },
      githubUserId: async () => "42",
    });
    expect(judgeSession.value).toEqual({
      githubUserId: "42",
      authentication: "github",
      subject: "GitHub numeric-ID allowlist",
      allowed: true,
    });

    const revoke = responseCapture();
    const grantId = tables.rows.get("judges")?.[0]?.$id;
    await handleControlPlane({
      req: { body: "" },
      res: revoke,
      path: new URL(
        `https://function.test/control/judges/github-user-id:${grantId}/revoke`,
      ),
      method: "PATCH",
      tables,
      config,
      user: { $id: "bootstrap" },
      githubUserId: async () => undefined,
    });
    expect(revoke.value.judge).toMatchObject({
      id: `github-user-id:${grantId}`,
      kind: "github-user-id",
      githubUserId: "42",
      label: "Judge",
      active: false,
    });

    const secretRes = responseCapture();
    await handleControlPlane({
      req: {
        body: JSON.stringify({
          label: "Registry",
          kind: "appwrite",
          secret: "not-for-output",
        }),
      },
      res: secretRes,
      path: new URL("https://function.test/control/secrets"),
      method: "POST",
      tables,
      config,
      user: { $id: "bootstrap" },
      githubUserId: async () => undefined,
    });
    expect(JSON.stringify(secretRes.value)).not.toContain("not-for-output");
    expect(tables.rows.get("secrets")?.[0]?.envelope).not.toContain(
      "not-for-output",
    );
  });

  it("allows an exact GitHub provider email or a hashed administrator-issued token", async () => {
    const tables = new FakeTables();
    const config = testConfig();
    await handleControlPlane({
      req: {
        body: JSON.stringify({
          githubEmail: "reviewer@example.com",
          label: "Email judge",
        }),
      },
      res: responseCapture(),
      path: new URL("https://function.test/control/judges"),
      method: "POST",
      tables,
      config,
      user: { $id: "bootstrap" },
    });
    const emailSession = responseCapture();
    await handleControlPlane({
      req: { body: "" },
      res: emailSession,
      path: new URL("https://function.test/control/judge/session"),
      method: "GET",
      tables,
      config,
      user: { $id: "judge-account" },
      githubIdentity: async () => ({
        githubUserId: "999",
        providerEmail: "REVIEWER@example.com",
      }),
    });
    expect(emailSession.value).toMatchObject({
      authentication: "github",
      subject: "GitHub email allowlist",
      allowed: true,
    });

    const created = responseCapture();
    await handleControlPlane({
      req: { body: JSON.stringify({ label: "Token judge", maxUses: 2 }) },
      res: created,
      path: new URL("https://function.test/control/judge-tokens"),
      method: "POST",
      tables,
      config,
      user: { $id: "bootstrap" },
    });
    expect(created.value.token).toMatch(/^lhic_judge_/);
    expect(JSON.stringify(tables.rows.get("judge-tokens"))).not.toContain(
      created.value.token,
    );
    const tokenSession = responseCapture();
    await handleControlPlane({
      req: { body: "" },
      res: tokenSession,
      path: new URL("https://function.test/control/judge/session"),
      method: "GET",
      tables,
      config,
      judgeToken: () => created.value.token,
    });
    expect(tokenSession.value).toMatchObject({
      authentication: "token",
      allowed: true,
    });
  });

  it("serves only registered, active judge assets with integrity metadata", async () => {
    const tables = new FakeTables();
    const config = testConfig();
    const create = responseCapture();
    await handleControlPlane({
      req: {
        body: JSON.stringify({
          title: "Internal benchmark report",
          kind: "benchmark",
          sourceUrl: "https://evidence.example.test/reports/internal.json",
          generatedAt: "2026-07-18T00:00:00.000Z",
          sha256: "a".repeat(64),
          metadata: { taskCount: 42, passed: true },
        }),
      },
      res: create,
      path: new URL("https://function.test/control/assets"),
      method: "POST",
      tables,
      config,
      user: { $id: "bootstrap" },
      githubUserId: async () => undefined,
    });
    expect(create.value.asset).toMatchObject({
      kind: "benchmark",
      metadata: { taskCount: 42, passed: true },
    });

    await handleControlPlane({
      req: { body: JSON.stringify({ githubUserId: "42", label: "Judge" }) },
      res: responseCapture(),
      path: new URL("https://function.test/control/judges"),
      method: "POST",
      tables,
      config,
      user: { $id: "bootstrap" },
      githubUserId: async () => undefined,
    });
    const catalog = responseCapture();
    await handleControlPlane({
      req: { body: "" },
      res: catalog,
      path: new URL("https://function.test/control/judge/catalog"),
      method: "GET",
      tables,
      config,
      user: { $id: "judge-account" },
      githubUserId: async () => "42",
    });
    expect(catalog.value.assets).toHaveLength(1);
    expect(catalog.value.assets[0]).toMatchObject({
      sourceUrl: "https://evidence.example.test/reports/internal.json",
      sha256: "a".repeat(64),
    });

    await expect(
      handleControlPlane({
        req: {
          body: JSON.stringify({
            title: "Unsafe",
            kind: "report",
            sourceUrl: "https://evidence.example.test/unsafe.json",
            generatedAt: "2026-07-18T00:00:00.000Z",
            sha256: "b".repeat(64),
            metadata: { apiKey: "must-not-store" },
          }),
        },
        res: responseCapture(),
        path: new URL("https://function.test/control/assets"),
        method: "POST",
        tables,
        config,
        user: { $id: "bootstrap" },
        githubUserId: async () => undefined,
      }),
    ).rejects.toThrow("credentials");
  });

  it("returns metadata-only Skill review rows to the administrator console", async () => {
    const tables = new FakeTables();
    tables.rows.set("skills", [
      {
        $id: "skill-1",
        $updatedAt: "2026-07-18T00:00:00.000Z",
        name: "verified search",
        version: "v1",
        status: "pending",
        fastPathEligible: false,
        payload: JSON.stringify({ secret: "must-not-reach-renderer" }),
      },
    ]);
    const res = responseCapture();

    await handleControlPlane({
      req: { body: "" },
      res,
      path: new URL("https://function.test/control/skills"),
      method: "GET",
      tables,
      config: testConfig(),
      user: { $id: "bootstrap" },
      githubUserId: async () => undefined,
    });

    expect(res.value.skills).toEqual([
      {
        id: "skill-1",
        name: "verified search",
        version: "v1",
        status: "pending",
        fastPathEligible: false,
        updatedAt: "2026-07-18T00:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(res.value)).not.toContain("must-not-reach-renderer");
  });

  it("accepts only policy-package metadata, then gates it by administrator review", async () => {
    const tables = new FakeTables();
    const config = testConfig();
    const request = {
      packageId: "a".repeat(64),
      core: "2d",
      profileId: "star-trooper",
      bundleUrl: "https://packages.example.test/star-trooper-v1.zip",
      bundleSha256: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      weightsSha256: "d".repeat(64),
      actionCodec: "game-2d-action-v1",
      evaluationReportSha256: "e".repeat(64),
      version: "v1",
    };
    const submitted = responseCapture();
    await expect(
      handleControlPlane({
        req: { body: JSON.stringify({ ...request, rawFrames: ["never"] }) },
        res: submitted,
        path: new URL("https://function.test/control/policy-packages"),
        method: "POST",
        tables,
        config,
        user: { $id: "member" },
        githubUserId: async () => undefined,
      }),
    ).rejects.toThrow("unsupported data");

    await handleControlPlane({
      req: { body: JSON.stringify(request) },
      res: submitted,
      path: new URL("https://function.test/control/policy-packages"),
      method: "POST",
      tables,
      config,
      user: { $id: "member" },
      githubUserId: async () => undefined,
    });
    expect(submitted.value.policyPackage).toMatchObject({
      core: "2d",
      status: "pending",
      bundleSha256: "b".repeat(64),
    });
    expect(JSON.stringify(submitted.value)).not.toContain("member");

    await handleControlPlane({
      req: { body: JSON.stringify({ githubUserId: "42", label: "Judge" }) },
      res: responseCapture(),
      path: new URL("https://function.test/control/judges"),
      method: "POST",
      tables,
      config,
      user: { $id: "bootstrap" },
      githubUserId: async () => undefined,
    });
    const judgeCatalog = responseCapture();
    await handleControlPlane({
      req: { body: "" },
      res: judgeCatalog,
      path: new URL("https://function.test/control/judge/policy-packages"),
      method: "GET",
      tables,
      config,
      user: { $id: "judge-account" },
      githubUserId: async () => "42",
    });
    expect(judgeCatalog.value.policyPackages).toEqual([]);

    const review = responseCapture();
    const id = submitted.value.policyPackage.id;
    await handleControlPlane({
      req: { body: JSON.stringify({ status: "approved" }) },
      res: review,
      path: new URL(
        `https://function.test/control/policy-packages/${id}/status`,
      ),
      method: "PATCH",
      tables,
      config,
      user: { $id: "bootstrap" },
      githubUserId: async () => undefined,
    });
    expect(review.value.policyPackage).toMatchObject({
      id,
      status: "approved",
    });

    await handleControlPlane({
      req: { body: "" },
      res: judgeCatalog,
      path: new URL("https://function.test/control/judge/policy-packages"),
      method: "GET",
      tables,
      config,
      user: { $id: "judge-account" },
      githubUserId: async () => "42",
    });
    expect(judgeCatalog.value.policyPackages).toHaveLength(1);
    expect(judgeCatalog.value.policyPackages[0]).toMatchObject({
      id,
      status: "approved",
      bundleUrl: request.bundleUrl,
    });
  });
});

class FakeTables {
  rows = new Map();

  async listRows({ tableId, queries = [] }) {
    if (
      queries.some(
        (query) => typeof query === "string" && query.includes("cursorAfter"),
      )
    ) {
      return { rows: [] };
    }
    return { rows: this.rows.get(tableId) ?? [] };
  }

  async createRow({ tableId, rowId, data }) {
    const row = { $id: rowId, $createdAt: "2026-07-18T00:00:00.000Z", ...data };
    const rows = this.rows.get(tableId) ?? [];
    rows.push(row);
    this.rows.set(tableId, rows);
    return row;
  }

  async updateRow({ tableId, rowId, data }) {
    const row = (this.rows.get(tableId) ?? []).find(
      (candidate) => candidate.$id === rowId,
    );
    Object.assign(row, data);
    return row;
  }
}

function responseCapture() {
  return {
    value: undefined,
    json(value) {
      this.value = value;
      return value;
    },
  };
}

function testConfig() {
  return {
    databaseId: "database",
    skillsTableId: "skills",
    rolesTableId: "roles",
    judgesTableId: "judges",
    judgeEmailsTableId: "judge-emails",
    judgeTokensTableId: "judge-tokens",
    demoKeysTableId: "keys",
    secretsTableId: "secrets",
    auditTableId: "audit",
    assetsTableId: "assets",
    policyPackagesTableId: "policy-packages",
    bootstrapAdminAccountId: "bootstrap",
    secretEncryptionKey: Buffer.alloc(32, 7),
  };
}
