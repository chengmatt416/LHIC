import { afterEach, beforeEach, describe, expect, it } from "vitest";

import handler, {
  publicSkill,
  publicUser,
  validateSubmission,
} from "./main.js";

const validSubmission = {
  schemaVersion: "shared-skill-v1",
  name: "shared search",
  contentHash: "a".repeat(64),
  operationKey: "operation:search",
  fingerprint: "b".repeat(64),
  templateVariables: ["query"],
  definition: {
    compiler: "shared-skill-v1",
    actions: [
      {
        type: "fill",
        intent: "fill search",
        target: "Search",
        value: "{{constraints.query}}",
        methodPreference: ["accessibility"],
        riskLevel: "low",
      },
    ],
    verification: [{ type: "dom" }],
  },
  fastPathEligible: true,
};

describe("Appwrite shared skill Function", () => {
  beforeEach(() => {
    process.env.LHIC_MOCK_APPWRITE = "true";
    process.env.APPWRITE_FUNCTION_API_ENDPOINT = "https://appwrite.test/v1";
    process.env.APPWRITE_FUNCTION_PROJECT_ID = "project";
    process.env.LHIC_SHARED_DATABASE_ID = "database";
    process.env.LHIC_SHARED_SKILLS_TABLE_ID = "skills";
    process.env.LHIC_DEVICE_PAIRS_TABLE_ID = "device-pairs";
    process.env.LHIC_SKILL_VERSIONS_TABLE_ID = "skill-versions";
    process.env.LHIC_SKILL_RATINGS_TABLE_ID = "skill-ratings";
    process.env.LHIC_USERS_TABLE_ID = "users";
  });
  afterEach(() => {
    delete process.env.LHIC_MOCK_APPWRITE;
    delete process.env.APPWRITE_FUNCTION_API_ENDPOINT;
    delete process.env.APPWRITE_FUNCTION_PROJECT_ID;
    delete process.env.LHIC_SHARED_DATABASE_ID;
    delete process.env.LHIC_SHARED_SKILLS_TABLE_ID;
    delete process.env.LHIC_DEVICE_PAIRS_TABLE_ID;
    delete process.env.LHIC_SKILL_VERSIONS_TABLE_ID;
    delete process.env.LHIC_SKILL_RATINGS_TABLE_ID;
    delete process.env.LHIC_USERS_TABLE_ID;
  });

  it("redacts submissions and removes unsafe records from Fast Path", () => {
    expect(validateSubmission(validSubmission)).toMatchObject({
      fastPathEligible: true,
      definition: validSubmission.definition,
    });

    const sensitiveValue = validateSubmission({
      ...validSubmission,
      definition: {
        ...validSubmission.definition,
        actions: [
          { ...validSubmission.definition.actions[0], value: "a@example.test" },
        ],
      },
    });
    expect(sensitiveValue).toMatchObject({
      fastPathEligible: false,
      definition: {
        actions: [expect.objectContaining({ value: "[REDACTED_EMAIL]" })],
      },
    });

    expect(
      validateSubmission({
        ...validSubmission,
        definition: {
          ...validSubmission.definition,
          actions: [
            {
              scope: "os",
              type: "os_type",
              intent: "type sensitive value",
              text: "hello",
              methodPreference: ["keyboard"],
              riskLevel: "low",
            },
          ],
        },
      }).fastPathEligible,
    ).toBe(false);
  });

  it("exposes approved snapshots without verifier data", () => {
    expect(
      publicSkill({
        $id: "skill-id",
        $updatedAt: "2026-07-16T00:00:00.000Z",
        version: "version",
        name: "shared search",
        operationKey: "operation:search",
        fingerprint: "fingerprint",
        fastPathEligible: true,
        contentHash: "hash",
        authorId: "author-1",
        description: "A verified search skill",
        category: "browser",
        tags: ["search"],
        downloadCount: 7,
        ratingAvg: 4.5,
        ratingCount: 2,
        createdAt: "2026-07-16T00:00:00.000Z",
        payload: JSON.stringify(validSubmission),
      }),
    ).toEqual({
      skillId: "skill-id",
      version: "version",
      name: "shared search",
      operationKey: "operation:search",
      fingerprint: "fingerprint",
      definition: {
        compiler: "shared-skill-v1",
        actions: validSubmission.definition.actions,
      },
      fastPathEligible: true,
      contentHash: "hash",
      description: "A verified search skill",
      category: "browser",
      tags: ["search"],
      downloadCount: 7,
      ratingAvg: 4.5,
      ratingCount: 2,
      authorId: "author-1",
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });
  });

  it("rejects malformed submissions before persistence", () => {
    expect(() =>
      validateSubmission({ ...validSubmission, schemaVersion: "wrong" }),
    ).toThrow("schema");
  });

  it("accepts optional marketplace metadata and rejects invalid values", () => {
    const enriched = validateSubmission({
      ...validSubmission,
      description: "Search public documentation",
      category: "browser",
      tags: ["search", "docs"],
    });
    expect(enriched).toMatchObject({
      description: "Search public documentation",
      category: "browser",
      tags: ["search", "docs"],
    });
    expect(() =>
      validateSubmission({ ...validSubmission, category: "gaming" }),
    ).toThrow("category");
    expect(() =>
      validateSubmission({ ...validSubmission, tags: ["a".repeat(33)] }),
    ).toThrow("tags");
    expect(() =>
      validateSubmission({ ...validSubmission, description: "x".repeat(1025) }),
    ).toThrow("description");
  });

  it("filters, searches and paginates the public skill list", async () => {
    const tables = new FakeTables();
    seedSkill(tables, "s1", {
      name: "browser nav",
      category: "browser",
      description: "navigate the web",
    });
    seedSkill(tables, "s2", {
      name: "desktop click",
      category: "desktop",
      description: "click native buttons",
    });
    seedSkill(tables, "s3", {
      name: "web scraper",
      category: "browser",
      description: "scrape search results",
    });
    for (let index = 0; index < 52; index += 1) {
      seedSkill(tables, `bulk-${index}`, {
        name: `bulk skill ${index}`,
        category: "os",
      });
    }

    const category = await invoke(tables, "/skills?category=browser");
    expect(category.value.skills.map((skill) => skill.skillId)).toEqual([
      "s1",
      "s3",
    ]);
    expect(category.value.total).toBe(2);
    expect(category.value.nextCursor).toBeUndefined();

    const search = await invoke(tables, "/skills?q=scrape");
    expect(search.value.skills.map((skill) => skill.skillId)).toEqual(["s3"]);

    const nameSearch = await invoke(tables, "/skills?q=desktop");
    expect(nameSearch.value.skills.map((skill) => skill.skillId)).toEqual([
      "s2",
    ]);

    const pageOne = await invoke(tables, "/skills?category=os");
    expect(pageOne.value.skills).toHaveLength(50);
    expect(pageOne.value.nextCursor).toBe("bulk-49");
    const pageTwo = await invoke(tables, "/skills?category=os&cursor=bulk-49");
    expect(pageTwo.value.skills.map((skill) => skill.skillId)).toEqual([
      "bulk-50",
      "bulk-51",
    ]);
    expect(pageTwo.value.nextCursor).toBeUndefined();

    const legacy = await invoke(tables, "/skills");
    expect(legacy.value.skills).toHaveLength(55);
    expect(legacy.value.cursor).toBeTypeOf("string");
    expect(legacy.value.nextCursor).toBeUndefined();
    expect(legacy.value.total).toBe(55);
  });

  it("creates a version row on submission and serves skill detail", async () => {
    const tables = new FakeTables();
    const submitted = await invoke(tables, "/skills", {
      method: "POST",
      body: validSubmission,
      jwt: "author-1",
    });
    expect(submitted.status).toBe(202);
    const skillRows = tables.rows.get("skills") ?? [];
    expect(skillRows).toHaveLength(1);
    expect(skillRows[0]).toMatchObject({
      status: "pending",
      authorId: "author-1",
      description: "",
      category: "utility",
      downloadCount: 0,
      ratingAvg: 0,
      ratingCount: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const versionRows = tables.rows.get("skill-versions") ?? [];
    expect(versionRows).toHaveLength(1);
    expect(versionRows[0]).toMatchObject({
      skillId: skillRows[0].$id,
      version: "1.0.0",
      contentHash: validSubmission.contentHash,
      changelog: "Initial submission",
      authorId: "author-1",
    });

    seedSkill(tables, "s1", {
      name: "rated search",
      description: "searches things",
      category: "browser",
      tags: ["search"],
      authorId: "author-1",
      downloadCount: 3,
    });
    tables.rows.set("users", [
      {
        $id: "author-1",
        userId: "author-1",
        displayName: "Alice",
        bio: "skill author",
        createdAt: "2026-08-01T00:00:00.000Z",
        lastActiveAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    tables.rows.set("skill-versions", [
      {
        $id: "v2",
        skillId: "s1",
        version: "2.0.0",
        contentHash: "c".repeat(64),
        changelog: "Faster matching",
        authorId: "author-1",
        createdAt: "2026-08-02T00:00:00.000Z",
      },
      {
        $id: "v1",
        skillId: "s1",
        version: "1.0.0",
        contentHash: "b".repeat(64),
        changelog: "Initial submission",
        authorId: "author-1",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const detail = await invoke(tables, "/skills/s1");
    expect(detail.value.skill).toMatchObject({
      skillId: "s1",
      category: "browser",
      downloadCount: 3,
    });
    expect(detail.value.versions.map((version) => version.version)).toEqual([
      "2.0.0",
      "1.0.0",
    ]);
    expect(detail.value.author).toMatchObject({
      userId: "author-1",
      displayName: "Alice",
    });
    expect(detail.value.rating).toEqual({ avg: 0, count: 0 });

    const versions = await invoke(tables, "/skills/s1/versions");
    expect(versions.value.versions).toHaveLength(2);
    expect(versions.value.versions[0].version).toBe("2.0.0");

    const missing = await invoke(tables, "/skills/not-there");
    expect(missing.status).toBe(404);
    expect(missing.value.error).toContain("Skill not found");
  });

  it("upserts ratings and recomputes average and count", async () => {
    const tables = new FakeTables();
    seedSkill(tables, "s1", { name: "rated", category: "browser" });

    const first = await invoke(tables, "/skills/s1/rate", {
      method: "POST",
      body: { rating: 5 },
      jwt: "user-1",
    });
    expect(first.value.skill).toMatchObject({ ratingAvg: 5, ratingCount: 1 });

    const second = await invoke(tables, "/skills/s1/rate", {
      method: "POST",
      body: { rating: 3 },
      jwt: "user-1",
    });
    expect(second.value.skill).toMatchObject({ ratingAvg: 3, ratingCount: 1 });
    expect(tables.rows.get("skill-ratings")).toHaveLength(1);

    const third = await invoke(tables, "/skills/s1/rate", {
      method: "POST",
      body: { rating: 4 },
      jwt: "user-2",
    });
    expect(third.value.skill).toMatchObject({
      ratingAvg: 3.5,
      ratingCount: 2,
    });

    const invalid = await invoke(tables, "/skills/s1/rate", {
      method: "POST",
      body: { rating: 7 },
      jwt: "user-1",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.value.error).toContain("between 1 and 5");
  });

  it("increments download counts and 404s missing skills", async () => {
    const tables = new FakeTables();
    seedSkill(tables, "s1", { name: "downloadable" });

    const first = await invoke(tables, "/skills/s1/download", {
      method: "POST",
    });
    expect(first.value).toEqual({ downloadCount: 1 });
    const second = await invoke(tables, "/skills/s1/download", {
      method: "POST",
    });
    expect(second.value).toEqual({ downloadCount: 2 });

    const missing = await invoke(tables, "/skills/nope/download", {
      method: "POST",
    });
    expect(missing.status).toBe(404);
  });

  it("creates and patches the signed-in user profile", async () => {
    const tables = new FakeTables();
    const created = await invoke(tables, "/users/me", { jwt: "user-abc" });
    expect(created.value.user).toMatchObject({
      userId: "user-abc",
      displayName: "mock",
    });
    expect(created.value.user.bio).toBeUndefined();
    expect(created.value.user.avatarUrl).toBeUndefined();
    expect(tables.rows.get("users")).toHaveLength(1);

    const patched = await invoke(tables, "/users/me", {
      method: "PATCH",
      body: {
        displayName: "Alice",
        bio: "Skill builder",
        avatarUrl: "https://example.test/avatar.png",
      },
      jwt: "user-abc",
    });
    expect(patched.value.user).toMatchObject({
      userId: "user-abc",
      displayName: "Alice",
      bio: "Skill builder",
      avatarUrl: "https://example.test/avatar.png",
    });
    expect(tables.rows.get("users")).toHaveLength(1);

    const invalid = await invoke(tables, "/users/me", {
      method: "PATCH",
      body: { displayName: "" },
      jwt: "user-abc",
    });
    expect(invalid.status).toBe(400);

    const publicProfile = await invoke(tables, "/users/user-abc");
    expect(publicProfile.value.user.displayName).toBe("Alice");
    const missingProfile = await invoke(tables, "/users/ghost");
    expect(missingProfile.status).toBe(404);
    expect(publicUser({ userId: "u", displayName: "N" })).toEqual({
      userId: "u",
      displayName: "N",
    });
  });

  it("purges expired device pairs before auth flows", async () => {
    const tables = new FakeTables();
    const now = Date.now();
    tables.rows.set("device-pairs", [
      {
        $id: "expired",
        codeHash: "h1",
        userId: "u",
        secret: "s",
        expiresAt: new Date(now - 60_000).toISOString(),
      },
      {
        $id: "live",
        codeHash:
          "8c97df4100b89fc982f0517a51dd93929f4de176e26e87291ecb09fc9a1bb992",
        userId: "u",
        secret: "s",
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    ]);
    const poll = await invoke(tables, `/auth/poll?device=${"y".repeat(40)}`);
    // Without the purge the poll would find the expired pair and answer 410;
    // 'complete' against the live pair proves the expired row was swept first.
    expect(poll.value.status).toBe("complete");
    expect(tables.rows.get("device-pairs")).toEqual([]);
  });
});

class FakeTables {
  rows = new Map();

  async listRows({ tableId, queries = [] }) {
    const parsedQueries = queries.flatMap((query) => {
      if (typeof query !== "string") return [];
      try {
        return [JSON.parse(query)];
      } catch {
        return [];
      }
    });
    let rows = [...(this.rows.get(tableId) ?? [])];
    for (const query of parsedQueries) {
      if (query.method === "equal") {
        rows = rows.filter((row) =>
          query.values.includes(row[query.attribute]),
        );
      }
      if (query.method === "lessThanEqual") {
        rows = rows.filter(
          (row) =>
            String(row[query.attribute] ?? "") <= String(query.values[0] ?? ""),
        );
      }
      if (query.method === "search") {
        const needle = String(query.values[0] ?? "").toLocaleLowerCase();
        rows = rows.filter((row) =>
          String(row[query.attribute] ?? "")
            .toLocaleLowerCase()
            .includes(needle),
        );
      }
    }
    const cursor = parsedQueries.find((query) => query.method === "cursorAfter")
      ?.values?.[0];
    if (cursor) {
      const cursorIndex = rows.findIndex((row) => row.$id === cursor);
      rows = cursorIndex >= 0 ? rows.slice(cursorIndex + 1) : [];
    }
    const offset =
      parsedQueries.find((query) => query.method === "offset")?.values?.[0] ??
      0;
    const limit =
      parsedQueries.find((query) => query.method === "limit")?.values?.[0] ??
      rows.length;
    return { rows: rows.slice(offset, offset + limit) };
  }

  async createRow({ tableId, rowId, data }) {
    const row = { $id: rowId, $createdAt: "2026-08-01T00:00:00.000Z", ...data };
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

  async deleteRow({ tableId, rowId }) {
    const rows = this.rows.get(tableId) ?? [];
    this.rows.set(
      tableId,
      rows.filter((candidate) => candidate.$id !== rowId),
    );
  }
}

function seedSkill(tables, id, overrides = {}) {
  const row = {
    $id: id,
    $createdAt: "2026-08-01T00:00:00.000Z",
    $updatedAt: "2026-08-01T00:00:00.000Z",
    name: "search",
    contentHash: "a".repeat(64),
    operationKey: "operation:search",
    fingerprint: "b".repeat(64),
    payload: JSON.stringify({
      schemaVersion: "shared-skill-v1",
      name: "search",
      definition: { actions: [{ type: "navigate", intent: "go" }] },
    }),
    fastPathEligible: false,
    status: "approved",
    authorId: "author-1",
    version: "v1",
    description: "",
    category: "utility",
    tags: [],
    downloadCount: 0,
    ratingAvg: 0,
    ratingCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
  const rows = tables.rows.get("skills") ?? [];
  rows.push(row);
  tables.rows.set("skills", rows);
  return row;
}

async function invoke(tables, path, options = {}) {
  const res = responseCapture();
  await handler({
    req: {
      method: options.method ?? "GET",
      path,
      body: options.body === undefined ? "" : JSON.stringify(options.body),
      headers: {
        "x-appwrite-key": "test-function-key",
        ...(options.jwt ? { "x-appwrite-user-jwt": options.jwt } : {}),
      },
    },
    res,
    error: () => {},
    tables,
  });
  return res;
}

function responseCapture() {
  return {
    value: undefined,
    status: undefined,
    json(value, status) {
      this.value = value;
      this.status = status;
      return value;
    },
    text(value) {
      this.value = value;
      return value;
    },
  };
}
