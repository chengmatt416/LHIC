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

/**
 * Appwrite HTTP Function entrypoint. Table rows must not grant direct client
 * access; the Function's dynamic key is the only database writer.
 */
export default async ({ req, res, error }) => {
  try {
    const config = runtimeConfig();
    const path = requestPath(req);
    const method = String(req.method ?? "GET").toUpperCase();
    const tables = new TablesDB(adminClient(req, config));

    if (method === "GET" && path.pathname === "/skills") {
      return res.json(await listPublicSkills(tables, config));
    }
    if (method === "POST" && path.pathname === "/skills") {
      const user = await authenticatedUser(req, config);
      const payload = validateSubmission(parseBody(req));
      await submitSkill(tables, config, user.$id, payload);
      return res.json({ status: "pending" }, 202);
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
      await receiveMagicCallback(tables, config, path.searchParams);
      return res.text(
        "LHIC shared skills login completed. You may close this window.",
      );
    }
    if (method === "GET" && path.pathname === "/auth/poll") {
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
  const existing = await tables.listRows({
    databaseId: config.databaseId,
    tableId: config.skillsTableId,
    queries: [Query.equal("contentHash", payload.contentHash), Query.limit(1)],
    total: false,
  });
  if (existing.rows.length > 0) {
    return;
  }
  await tables.createRow({
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
    },
  });
}

async function listPublicSkills(tables, config) {
  const approved = await listRows(
    tables,
    config,
    config.skillsTableId,
    "approved",
  );
  const revoked = await listRows(
    tables,
    config,
    config.skillsTableId,
    "revoked",
  );
  return {
    skills: approved.map((row) => publicSkill(row)),
    revokedSkillIds: revoked.map((row) => row.$id),
    cursor: new Date().toISOString(),
  };
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
