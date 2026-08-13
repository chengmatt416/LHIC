import { Account, Client, ID, Query, TablesDB } from "node-appwrite";
import { createHash } from "node:crypto";

import {
  controlConfigFromEnvironment,
  handleControlPlane,
} from "./control-plane.js";

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phonePattern = /(?<!\w)(?:\+?\d[\d().\-\s]{7,}\d)(?!\w)/g;
const tokenPattern =
  /\b(?:Bearer\s+)?(?:eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:sk|pk|tok|api)[_-][A-Za-z0-9_-]{12,})\b/gi;
const sensitiveKeyPattern =
  /(password|passphrase|pwd|token|secret|api[_-]?key|authorization|cookie)/i;
const redactedValuePattern = /\[REDACTED(?:_[A-Z_]+)?\]/;
const browserActionTypes = new Set([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "wait",
  "download",
  "custom",
]);
const actionMethods = new Set([
  "api",
  "dom",
  "accessibility",
  "keyboard",
  "ocr",
  "vision",
  "mouse",
]);
const skillCategories = new Set([
  "browser",
  "desktop",
  "os",
  "mcp",
  "training",
  "utility",
]);

/**
 * Appwrite HTTP Function entrypoint. Table rows must not grant direct client
 * access; the Function's dynamic key is the only database writer.
 */
export default async ({ req, res, error, tables: injectedTables }) => {
  try {
    const config = runtimeConfig();
    const path = requestPath(req);
    const method = String(req.method ?? "GET").toUpperCase();
    const tables = injectedTables ?? new TablesDB(adminClient(req, config));

    if (method === "GET" && path.pathname === "/skills") {
      return res.json(
        await listPublicSkills(tables, config, path.searchParams),
      );
    }
    if (method === "POST" && path.pathname === "/skills") {
      const user = await authenticatedUser(req, config);
      const payload = validateSubmission(parseBody(req));
      await submitSkill(tables, config, user.$id, payload);
      return res.json({ status: "pending" }, 202);
    }
    const skillVersionsMatch = path.pathname.match(
      /^\/skills\/([^/]+)\/versions$/,
    );
    if (method === "GET" && skillVersionsMatch) {
      await requireSkill(tables, config, skillVersionsMatch[1]);
      return res.json({
        versions: await listSkillVersions(
          tables,
          config,
          skillVersionsMatch[1],
        ),
      });
    }
    const skillRateMatch = path.pathname.match(/^\/skills\/([^/]+)\/rate$/);
    if (method === "POST" && skillRateMatch) {
      const user = await authenticatedUser(req, config);
      const body = parseBody(req);
      if (!isRecord(body) || !Number.isInteger(body.rating)) {
        throw new HttpError(400, "Skill rating must be an integer.");
      }
      if (body.rating < 1 || body.rating > 5) {
        throw new HttpError(400, "Skill rating must be between 1 and 5.");
      }
      const skill = await rateSkill(
        tables,
        config,
        user.$id,
        skillRateMatch[1],
        body.rating,
      );
      return res.json({ skill });
    }
    const skillDownloadMatch = path.pathname.match(
      /^\/skills\/([^/]+)\/download$/,
    );
    if (method === "POST" && skillDownloadMatch) {
      return res.json(
        await recordSkillDownload(tables, config, skillDownloadMatch[1]),
      );
    }
    const skillDetailMatch = path.pathname.match(/^\/skills\/([^/]+)$/);
    if (method === "GET" && skillDetailMatch) {
      return res.json(await skillDetail(tables, config, skillDetailMatch[1]));
    }
    if (method === "GET" && path.pathname === "/users/me") {
      const user = await authenticatedUser(req, config);
      const row = await ensureUserProfile(tables, config, user);
      return res.json({ user: publicUser(row) });
    }
    if (method === "PATCH" && path.pathname === "/users/me") {
      const user = await authenticatedUser(req, config);
      const body = parseBody(req);
      if (!isRecord(body)) {
        throw new HttpError(400, "User profile body must be a JSON object.");
      }
      const row = await updateUserProfile(tables, config, user, body);
      return res.json({ user: publicUser(row) });
    }
    const userMatch = path.pathname.match(/^\/users\/([^/]+)$/);
    if (method === "GET" && userMatch) {
      const row = await getUserRow(tables, config, userMatch[1]);
      if (!row) {
        throw new HttpError(404, "User not found.");
      }
      return res.json({ user: publicUser(row) });
    }
    if (path.pathname.startsWith("/control/")) {
      const controlConfig = { ...config, ...controlConfigFromEnvironment() };
      const token = header(req, "x-lhic-judge-token");
      const user =
        isJudgeReadRoute(path.pathname) && token
          ? undefined
          : await authenticatedUser(req, config);
      return handleControlPlane({
        req,
        res,
        path,
        method,
        tables,
        config: controlConfig,
        user,
        githubIdentity: () => githubIdentity(req, config),
        judgeToken: () => token,
      });
    }
    if (method === "GET" && path.pathname === "/auth/callback") {
      await purgeExpiredDevicePairs(tables, config);
      await receiveMagicCallback(tables, config, path.searchParams);
      return res.text(
        "LHIC shared skills login completed. You may close this window.",
      );
    }
    if (method === "GET" && path.pathname === "/auth/poll") {
      await purgeExpiredDevicePairs(tables, config);
      return res.json(await pollDevicePair(tables, config, path.searchParams));
    }
    return res.json({ error: "Not found." }, 404);
  } catch (caught) {
    const status = statusFor(caught);
    const message =
      caught instanceof Error ? caught.message : "Request failed.";
    error(`shared-skills request failed with HTTP ${status}`);
    return res.json({ error: publicError(message) }, status);
  }
};

function runtimeConfig() {
  const endpoint = requiredEnvironment("APPWRITE_FUNCTION_API_ENDPOINT");
  const projectId = requiredEnvironment("APPWRITE_FUNCTION_PROJECT_ID");
  return {
    endpoint,
    projectId,
    databaseId: requiredEnvironment("LHIC_SHARED_DATABASE_ID"),
    skillsTableId: requiredEnvironment("LHIC_SHARED_SKILLS_TABLE_ID"),
    devicePairsTableId: requiredEnvironment("LHIC_DEVICE_PAIRS_TABLE_ID"),
    skillVersionsTableId: requiredEnvironment("LHIC_SKILL_VERSIONS_TABLE_ID"),
    skillRatingsTableId: requiredEnvironment("LHIC_SKILL_RATINGS_TABLE_ID"),
    usersTableId: requiredEnvironment("LHIC_USERS_TABLE_ID"),
  };
}

function adminClient(req, config) {
  const dynamicKey = header(req, "x-appwrite-key");
  if (!dynamicKey) {
    throw new HttpError(500, "Function dynamic API key is unavailable.");
  }
  return new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setKey(dynamicKey);
}

async function authenticatedUser(req, config) {
  const jwt = header(req, "x-appwrite-user-jwt");
  if (process.env.LHIC_MOCK_APPWRITE === "true") {
    // Test seam mirroring the desktop client's mock mode: never touches the
    // Appwrite account endpoint, so route tests run without credentials.
    const identity = String(jwt ?? "mock-user").slice(0, 36);
    return { $id: identity, email: "mock@example.com" };
  }
  if (!jwt) {
    throw new HttpError(401, "Sign-in is required to submit a shared skill.");
  }
  const client = new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setJWT(jwt);
  try {
    return await new Account(client).get();
  } catch {
    throw new HttpError(401, "Shared skill sign-in is invalid or expired.");
  }
}

async function githubIdentity(req, config) {
  const jwt = header(req, "x-appwrite-user-jwt");
  if (!jwt) return undefined;
  const client = new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId)
    .setJWT(jwt);
  try {
    const identities = await new Account(client).listIdentities();
    const github = identities.identities.find(
      (identity) => identity.provider === "github",
    );
    if (typeof github?.providerUid !== "string") return undefined;
    return {
      githubUserId: github.providerUid,
      ...(typeof github.providerEmail === "string" &&
      github.providerEmail.trim()
        ? { providerEmail: github.providerEmail }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function isJudgeReadRoute(pathname) {
  return [
    "/control/judge/session",
    "/control/judge/catalog",
    "/control/judge/policy-packages",
  ].includes(pathname);
}

async function submitSkill(tables, config, authorId, payload) {
  const now = new Date().toISOString();
  const existing = await tables.listRows({
    databaseId: config.databaseId,
    tableId: config.skillsTableId,
    queries: [Query.equal("contentHash", payload.contentHash), Query.limit(1)],
    total: false,
  });
  if (existing.rows.length > 0) {
    return;
  }
  const row = await tables.createRow({
    databaseId: config.databaseId,
    tableId: config.skillsTableId,
    rowId: ID.unique(),
    data: {
      name: payload.name,
      contentHash: payload.contentHash,
      operationKey: payload.operationKey,
      fingerprint: payload.fingerprint,
      payload: JSON.stringify(payload),
      fastPathEligible: payload.fastPathEligible,
      status: "pending",
      authorId,
      version: payload.contentHash.slice(0, 16),
      description: payload.description ?? "",
      category: payload.category ?? "utility",
      tags: payload.tags ?? [],
      downloadCount: 0,
      ratingAvg: 0,
      ratingCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  });
  await tables.createRow({
    databaseId: config.databaseId,
    tableId: config.skillVersionsTableId,
    rowId: ID.unique(),
    data: {
      skillId: row.$id,
      version: "1.0.0",
      contentHash: payload.contentHash,
      payload: JSON.stringify(payload),
      changelog: "Initial submission",
      authorId,
      createdAt: now,
    },
  });
}

async function listPublicSkills(tables, config, searchParams) {
  const category = searchParams.get("category");
  const q = searchParams.get("q");
  const cursor = searchParams.get("cursor");
  const paged = [...searchParams.keys()].length > 0;
  const revoked = await listRows(
    tables,
    config,
    config.skillsTableId,
    "revoked",
  );
  if (!paged) {
    const approved = await listRows(
      tables,
      config,
      config.skillsTableId,
      "approved",
    );
    return {
      skills: approved.map((row) => publicSkill(row)),
      revokedSkillIds: revoked.map((row) => row.$id),
      cursor: new Date().toISOString(),
      total: approved.length,
    };
  }

  const baseQueries = [Query.equal("status", "approved")];
  if (category) {
    baseQueries.push(Query.equal("category", category));
  }
  let candidates;
  if (q) {
    const [nameMatches, descriptionMatches] = await Promise.all([
      listTableRows(
        tables,
        config,
        config.skillsTableId,
        [...baseQueries, Query.search("name", q)],
        undefined,
        50,
      ),
      listTableRows(
        tables,
        config,
        config.skillsTableId,
        [...baseQueries, Query.search("description", q)],
        undefined,
        50,
      ),
    ]);
    candidates = [
      ...new Map(
        [...nameMatches, ...descriptionMatches].map((row) => [row.$id, row]),
      ).values(),
    ];
  } else {
    candidates = await listTableRows(
      tables,
      config,
      config.skillsTableId,
      baseQueries,
      undefined,
      50,
    );
  }
  const filtered = candidates.filter((row) =>
    matchesSkillFilters(row, category, q),
  );
  const cursorIndex = cursor
    ? filtered.findIndex((row) => row.$id === cursor)
    : -1;
  const start = cursorIndex >= 0 ? cursorIndex + 1 : 0;
  const page = filtered.slice(start, start + 50);
  return {
    skills: page.map((row) => publicSkill(row)),
    revokedSkillIds: revoked.map((row) => row.$id),
    cursor: new Date().toISOString(),
    ...(start + 50 < filtered.length ? { nextCursor: page.at(-1)?.$id } : {}),
    total: filtered.length,
  };
}

function matchesSkillFilters(row, category, q) {
  if (category && String(row.category ?? "") !== category) {
    return false;
  }
  if (q) {
    const needle = q.toLocaleLowerCase();
    const haystack =
      `${String(row.name ?? "")} ${String(row.description ?? "")}`.toLocaleLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }
  return true;
}

async function requireSkill(tables, config, skillId) {
  const rows = await listTableRows(
    tables,
    config,
    config.skillsTableId,
    [],
    (row) => row.$id === skillId,
  );
  const row = rows[0];
  if (!row) {
    throw new HttpError(404, "Skill not found.");
  }
  return row;
}

async function listSkillVersions(tables, config, skillId) {
  const rows = await listTableRows(
    tables,
    config,
    config.skillVersionsTableId,
    [],
    (row) => row.skillId === skillId,
  );
  return rows
    .sort((left, right) =>
      String(right.createdAt).localeCompare(String(left.createdAt)),
    )
    .map((row) => ({
      version: String(row.version),
      contentHash: String(row.contentHash),
      ...(row.changelog ? { changelog: String(row.changelog) } : {}),
      createdAt: String(row.createdAt),
    }));
}

async function skillDetail(tables, config, skillId) {
  const row = await requireSkill(tables, config, skillId);
  const author = row.authorId
    ? await getUserRow(tables, config, String(row.authorId))
    : undefined;
  const ratings = await listTableRows(
    tables,
    config,
    config.skillRatingsTableId,
    [Query.equal("skillId", skillId)],
    (candidate) => candidate.skillId === skillId,
  );
  const count = ratings.length;
  const avg = count
    ? Math.round(
        (ratings.reduce((sum, rating) => sum + Number(rating.rating), 0) /
          count) *
          10,
      ) / 10
    : 0;
  return {
    skill: publicSkill(row),
    versions: await listSkillVersions(tables, config, skillId),
    author: author ? publicUser(author) : null,
    rating: { avg, count },
  };
}

async function rateSkill(tables, config, userId, skillId, rating) {
  const skill = await requireSkill(tables, config, skillId);
  const now = new Date().toISOString();
  const existing = await listTableRows(
    tables,
    config,
    config.skillRatingsTableId,
    [Query.equal("skillId", skillId), Query.equal("userId", userId)],
    (row) => row.skillId === skillId && row.userId === userId,
  );
  if (existing.length > 0) {
    await tables.updateRow({
      databaseId: config.databaseId,
      tableId: config.skillRatingsTableId,
      rowId: existing[0].$id,
      data: { rating, createdAt: now },
    });
  } else {
    await tables.createRow({
      databaseId: config.databaseId,
      tableId: config.skillRatingsTableId,
      rowId: ID.unique(),
      data: { skillId, userId, rating, createdAt: now },
    });
  }
  const ratings = await listTableRows(
    tables,
    config,
    config.skillRatingsTableId,
    [Query.equal("skillId", skillId)],
    (row) => row.skillId === skillId,
  );
  const count = ratings.length;
  const ratingAvg = count
    ? Math.round(
        (ratings.reduce((sum, row) => sum + Number(row.rating), 0) / count) *
          10,
      ) / 10
    : 0;
  const updated = await tables.updateRow({
    databaseId: config.databaseId,
    tableId: config.skillsTableId,
    rowId: skill.$id,
    data: {
      ratingAvg,
      ratingCount: count,
      updatedAt: new Date().toISOString(),
    },
  });
  return publicSkill(updated);
}

async function recordSkillDownload(tables, config, skillId) {
  const skill = await requireSkill(tables, config, skillId);
  const downloadCount = Number(skill.downloadCount ?? 0) + 1;
  await tables.updateRow({
    databaseId: config.databaseId,
    tableId: config.skillsTableId,
    rowId: skill.$id,
    data: { downloadCount, updatedAt: new Date().toISOString() },
  });
  return { downloadCount };
}

async function getUserRow(tables, config, userId) {
  const rows = await listTableRows(
    tables,
    config,
    config.usersTableId,
    [Query.equal("userId", userId)],
    (row) => row.userId === userId,
  );
  return rows[0];
}

async function ensureUserProfile(tables, config, user) {
  const existing = await getUserRow(tables, config, user.$id);
  if (existing) {
    return existing;
  }
  return tables.createRow({
    databaseId: config.databaseId,
    tableId: config.usersTableId,
    rowId: ID.unique(),
    data: {
      userId: user.$id,
      displayName: String(user.email?.split("@")[0] ?? user.$id),
      bio: null,
      avatarUrl: null,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    },
  });
}

async function updateUserProfile(tables, config, user, body) {
  const now = new Date().toISOString();
  const displayName =
    body.displayName === undefined
      ? undefined
      : requiredProfileString(body.displayName, "displayName", 128, true);
  const bio =
    body.bio === undefined
      ? undefined
      : requiredProfileString(body.bio, "bio", 512, false);
  const avatarUrl =
    body.avatarUrl === undefined
      ? undefined
      : requiredProfileString(body.avatarUrl, "avatarUrl", 2048, false);
  const existing = await getUserRow(tables, config, user.$id);
  if (!existing) {
    return tables.createRow({
      databaseId: config.databaseId,
      tableId: config.usersTableId,
      rowId: ID.unique(),
      data: {
        userId: user.$id,
        displayName:
          displayName ?? String(user.email?.split("@")[0] ?? user.$id),
        bio: bio ?? null,
        avatarUrl: avatarUrl ?? null,
        createdAt: now,
        lastActiveAt: now,
      },
    });
  }
  const data = { lastActiveAt: now };
  if (displayName !== undefined) data.displayName = displayName;
  if (bio !== undefined) data.bio = bio;
  if (avatarUrl !== undefined) data.avatarUrl = avatarUrl;
  return tables.updateRow({
    databaseId: config.databaseId,
    tableId: config.usersTableId,
    rowId: existing.$id,
    data,
  });
}

function requiredProfileString(value, name, maximum, mustBeNonEmpty) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (mustBeNonEmpty && !value.trim())
  ) {
    throw new HttpError(400, `${name} is invalid.`);
  }
  return value;
}

export function publicUser(row) {
  return {
    userId: String(row.userId),
    displayName: String(row.displayName),
    ...(row.bio ? { bio: String(row.bio) } : {}),
    ...(row.avatarUrl ? { avatarUrl: String(row.avatarUrl) } : {}),
  };
}

async function purgeExpiredDevicePairs(tables, config) {
  try {
    const now = Date.now();
    const expired = await listTableRows(
      tables,
      config,
      config.devicePairsTableId,
      [Query.lessThanEqual("expiresAt", new Date(now).toISOString())],
      (row) =>
        Boolean(row.expiresAt) && Date.parse(String(row.expiresAt)) <= now,
    );
    for (const row of expired) {
      await tables.deleteRow({
        databaseId: config.databaseId,
        tableId: config.devicePairsTableId,
        rowId: row.$id,
      });
    }
  } catch {
    // Best-effort per-request TTL sweep; never fail the auth flow.
  }
}

async function listTableRows(
  tables,
  config,
  tableId,
  queries,
  predicate,
  pageSize = 100,
) {
  const rows = [];
  let offset = 0;
  while (true) {
    const result = await tables.listRows({
      databaseId: config.databaseId,
      tableId,
      queries: [
        ...queries,
        Query.limit(pageSize),
        ...(offset > 0 ? [Query.offset(offset)] : []),
      ],
      total: false,
    });
    for (const row of result.rows) {
      if (!predicate || predicate(row)) rows.push(row);
    }
    if (result.rows.length < pageSize) {
      break;
    }
    offset += result.rows.length;
  }
  return rows;
}

async function listRows(tables, config, tableId, status) {
  const rows = [];
  let cursor;
  do {
    const result = await tables.listRows({
      databaseId: config.databaseId,
      tableId,
      queries: [
        Query.equal("status", status),
        Query.limit(100),
        ...(cursor ? [Query.cursorAfter(cursor)] : []),
      ],
      total: false,
    });
    rows.push(...result.rows);
    cursor = result.rows.at(-1)?.$id;
  } while (cursor);
  return rows;
}

export function publicSkill(row) {
  const payload = JSON.parse(String(row.payload));
  const definition = isRecord(payload.definition)
    ? { ...payload.definition }
    : {};
  delete definition.verification;
  return {
    skillId: row.$id,
    version: String(row.version),
    name: String(row.name),
    operationKey: String(row.operationKey),
    fingerprint: String(row.fingerprint),
    definition,
    fastPathEligible: row.fastPathEligible === true,
    contentHash: String(row.contentHash),
    description: String(row.description ?? ""),
    category: String(row.category ?? "utility"),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    downloadCount: Number(row.downloadCount ?? 0),
    ratingAvg: Number(row.ratingAvg ?? 0),
    ratingCount: Number(row.ratingCount ?? 0),
    authorId: String(row.authorId ?? ""),
    createdAt: String(row.createdAt ?? row.$createdAt),
    updatedAt: String(row.$updatedAt),
  };
}

async function receiveMagicCallback(tables, config, searchParams) {
  const device = searchParams.get("device");
  const userId = searchParams.get("userId");
  const secret = searchParams.get("secret");
  if (!device || !userId || !secret || device.length < 40) {
    throw new HttpError(400, "Magic URL callback is invalid.");
  }
  await tables.createRow({
    databaseId: config.databaseId,
    tableId: config.devicePairsTableId,
    rowId: ID.unique(),
    data: {
      codeHash: sha256(device),
      userId,
      secret,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
  });
}

async function pollDevicePair(tables, config, searchParams) {
  const device = searchParams.get("device");
  if (!device || device.length < 40) {
    throw new HttpError(400, "Magic URL device code is invalid.");
  }
  const matches = await tables.listRows({
    databaseId: config.databaseId,
    tableId: config.devicePairsTableId,
    queries: [Query.equal("codeHash", sha256(device)), Query.limit(1)],
    total: false,
  });
  const pair = matches.rows[0];
  if (!pair) {
    return { status: "pending" };
  }
  await tables.deleteRow({
    databaseId: config.databaseId,
    tableId: config.devicePairsTableId,
    rowId: pair.$id,
  });
  if (Date.parse(String(pair.expiresAt)) <= Date.now()) {
    throw new HttpError(410, "Magic URL device code expired.");
  }
  return { status: "complete", userId: pair.userId, secret: pair.secret };
}

export function validateSubmission(value) {
  if (!isRecord(value) || value.schemaVersion !== "shared-skill-v1") {
    throw new HttpError(400, "Shared skill submission schema is invalid.");
  }
  const requiredString = (source, key, maxLength) => {
    const field = source[key];
    if (
      typeof field !== "string" ||
      !field.trim() ||
      field.length > maxLength
    ) {
      throw new HttpError(400, `Shared skill ${key} is invalid.`);
    }
    return field;
  };
  if (
    !isRecord(value.definition) ||
    typeof value.fastPathEligible !== "boolean" ||
    !Array.isArray(value.templateVariables) ||
    !value.templateVariables.every(
      (templateVariable) =>
        typeof templateVariable === "string" &&
        /^[A-Za-z0-9_.-]+$/.test(templateVariable),
    ) ||
    !Array.isArray(value.definition.actions) ||
    value.definition.actions.length === 0
  ) {
    throw new HttpError(400, "Shared skill definition is invalid.");
  }
  if (value.description !== undefined) {
    if (
      typeof value.description !== "string" ||
      !value.description.trim() ||
      value.description.length > 1024
    ) {
      throw new HttpError(400, "Shared skill description is invalid.");
    }
  }
  if (value.category !== undefined) {
    if (
      typeof value.category !== "string" ||
      !skillCategories.has(value.category)
    ) {
      throw new HttpError(400, "Shared skill category is invalid.");
    }
  }
  if (value.tags !== undefined) {
    if (
      !Array.isArray(value.tags) ||
      value.tags.length > 8 ||
      !value.tags.every(
        (tag) => typeof tag === "string" && tag.trim() && tag.length <= 32,
      )
    ) {
      throw new HttpError(400, "Shared skill tags are invalid.");
    }
  }
  const sanitized = redact(value);
  return {
    ...sanitized,
    schemaVersion: "shared-skill-v1",
    name: requiredString(sanitized, "name", 128),
    contentHash: requiredString(sanitized, "contentHash", 128),
    operationKey: requiredString(sanitized, "operationKey", 256),
    fingerprint: requiredString(sanitized, "fingerprint", 128),
    definition: sanitized.definition,
    fastPathEligible:
      value.fastPathEligible && isSafeFastPathDefinition(sanitized.definition),
    ...(typeof sanitized.description === "string"
      ? { description: sanitized.description.trim() }
      : {}),
    ...(typeof sanitized.category === "string"
      ? { category: sanitized.category }
      : {}),
    ...(Array.isArray(sanitized.tags)
      ? { tags: sanitized.tags.map((tag) => tag.trim()) }
      : {}),
  };
}

function isSafeFastPathDefinition(definition) {
  return (
    isRecord(definition) &&
    Array.isArray(definition.actions) &&
    definition.actions.length > 0 &&
    definition.actions.every(isSafeBrowserAction)
  );
}

function isSafeBrowserAction(action) {
  if (
    !isRecord(action) ||
    (action.scope !== undefined && action.scope !== "browser") ||
    !browserActionTypes.has(action.type) ||
    action.riskLevel !== "low" ||
    typeof action.intent !== "string" ||
    !action.intent.trim() ||
    !Array.isArray(action.methodPreference) ||
    action.methodPreference.length === 0 ||
    !action.methodPreference.every((method) => actionMethods.has(method))
  ) {
    return false;
  }
  return !containsRedactedValue(action);
}

function containsRedactedValue(value) {
  if (typeof value === "string") {
    return redactedValuePattern.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsRedactedValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.values(value).some(containsRedactedValue);
}

function parseBody(req) {
  try {
    return JSON.parse(String(req.body ?? ""));
  } catch {
    throw new HttpError(400, "Shared skill request body must be JSON.");
  }
}

function redact(value) {
  if (typeof value === "string") {
    return value
      .replace(emailPattern, "[REDACTED_EMAIL]")
      .replace(phonePattern, "[REDACTED_PHONE]")
      .replace(tokenPattern, "[REDACTED_TOKEN]");
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : redact(item),
    ]),
  );
}

function requestPath(req) {
  return new URL(String(req.path ?? "/"), "https://lhic-function.invalid");
}

function header(req, name) {
  const headers = req.headers ?? {};
  return (
    headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
  );
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new HttpError(500, `${name} is not configured.`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function publicError(message) {
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function statusFor(error) {
  return error instanceof HttpError ||
    (isRecord(error) && Number.isInteger(error.status))
    ? error.status
    : 500;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
