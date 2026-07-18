import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { ID, Query } from "node-appwrite";

const roles = new Set(["admin", "member"]);
const skillStatuses = new Set(["pending", "approved", "rejected", "revoked"]);
const assetKinds = new Set([
  "benchmark",
  "trace",
  "presentation",
  "guide",
  "report",
]);
const keyScopePattern = /^[a-z][a-z0-9:_-]{0,63}$/;

/**
 * Dashboard-only routes. The caller supplies an authenticated Appwrite user
 * and a TablesDB client with the Function dynamic key; no table grants direct
 * client access.
 */
export async function handleControlPlane({
  req,
  res,
  path,
  method,
  tables,
  config,
  user,
  githubIdentity,
  githubUserId,
  judgeToken,
}) {
  const route = path.pathname;
  const identity = async () => {
    if (githubIdentity) return githubIdentity();
    const id = githubUserId ? await githubUserId() : undefined;
    return id ? { githubUserId: id } : undefined;
  };
  if (route === "/control/session" && method === "GET") {
    const github = await identity();
    const admin = await isAdmin(tables, config, user.$id);
    return res.json({
      accountId: user.$id,
      admin,
      githubUserId: github?.githubUserId ?? null,
      judge: Boolean(await judgeAccess(tables, config, github, judgeToken?.())),
    });
  }

  if (route === "/control/judge/session" && method === "GET") {
    return res.json(
      await requireJudgeAccess(tables, config, identity, judgeToken),
    );
  }

  if (route === "/control/judge/catalog" && method === "GET") {
    await requireJudgeAccess(tables, config, identity, judgeToken);
    const assets = await listRows(tables, config, config.assetsTableId);
    return res.json({
      assets: assets.filter(isActiveAsset).map(publicAsset),
    });
  }

  if (route === "/control/judge/policy-packages" && method === "GET") {
    await requireJudgeAccess(tables, config, identity, judgeToken);
    const rows = await listRows(tables, config, config.policyPackagesTableId);
    return res.json({
      policyPackages: rows
        .filter((row) => row.status === "approved")
        .map(publicPolicyPackage),
    });
  }

  if (route === "/control/policy-packages" && method === "POST") {
    const policyPackage = validatePolicyPackage(objectBody(req));
    const existing = await tables.listRows({
      databaseId: config.databaseId,
      tableId: config.policyPackagesTableId,
      queries: [
        Query.equal("packageId", policyPackage.packageId),
        Query.limit(1),
      ],
      total: false,
    });
    if (existing.rows.length > 0) {
      throw httpError(409, "This policy package has already been submitted.");
    }
    const row = await tables.createRow({
      databaseId: config.databaseId,
      tableId: config.policyPackagesTableId,
      rowId: ID.unique(),
      data: { ...policyPackage, status: "pending", authorId: user.$id },
    });
    await audit(tables, config, user.$id, "policy-package.submit", row.$id, {
      packageId: policyPackage.packageId,
      bundleSha256: policyPackage.bundleSha256,
    });
    return res.json({ policyPackage: publicPolicyPackage(row) }, 201);
  }

  await requireAdmin(tables, config, user.$id);

  if (route === "/control/roles" && method === "GET") {
    return res.json({
      roles: await listRows(tables, config, config.rolesTableId),
    });
  }
  if (route === "/control/roles" && method === "POST") {
    const body = objectBody(req);
    const accountId = requiredString(body.accountId, "accountId", 36);
    const role = requiredString(body.role, "role", 16);
    if (!roles.has(role)) throw httpError(400, "Role is invalid.");
    const row = await tables.createRow({
      databaseId: config.databaseId,
      tableId: config.rolesTableId,
      rowId: ID.unique(),
      data: { accountId, role, active: true },
    });
    await audit(tables, config, user.$id, "role.grant", row.$id, { role });
    return res.json({ id: row.$id, accountId, role }, 201);
  }

  if (route === "/control/judges" && method === "GET") {
    const githubIds = await listRows(tables, config, config.judgesTableId);
    const githubEmails = await listRows(
      tables,
      config,
      config.judgeEmailsTableId,
    );
    return res.json({
      judges: [
        ...githubIds.map((row) => publicJudge(row, "github-user-id")),
        ...githubEmails.map((row) => publicJudge(row, "github-email")),
      ],
    });
  }
  if (route === "/control/judges" && method === "POST") {
    const body = objectBody(req);
    const grant = validateJudgeGrant(body);
    const label = requiredString(body.label, "label", 128);
    const expiresAt = optionalIsoDate(body.expiresAt);
    const row = await tables.createRow({
      databaseId: config.databaseId,
      tableId:
        grant.kind === "github-user-id"
          ? config.judgesTableId
          : config.judgeEmailsTableId,
      rowId: ID.unique(),
      data: {
        ...(grant.kind === "github-user-id"
          ? { githubUserId: grant.value }
          : { githubEmail: grant.value }),
        label,
        active: true,
        expiresAt: expiresAt ?? null,
      },
    });
    await audit(tables, config, user.$id, "judge.grant", row.$id, {
      kind: grant.kind,
    });
    return res.json(publicJudge(row, grant.kind), 201);
  }
  const judgeRevokeMatch = route.match(/^\/control\/judges\/([^/]+)\/revoke$/);
  if (judgeRevokeMatch && method === "PATCH") {
    const grant = parseJudgeGrantId(judgeRevokeMatch[1]);
    const row = await tables.updateRow({
      databaseId: config.databaseId,
      tableId:
        grant.kind === "github-user-id"
          ? config.judgesTableId
          : config.judgeEmailsTableId,
      rowId: grant.rowId,
      data: { active: false },
    });
    await audit(tables, config, user.$id, "judge.revoke", grant.rowId, {
      kind: grant.kind,
    });
    return res.json({ judge: publicJudge(row, grant.kind) });
  }

  if (route === "/control/judge-tokens" && method === "GET") {
    const rows = await listRows(tables, config, config.judgeTokensTableId);
    return res.json({ tokens: rows.map(publicJudgeToken) });
  }
  if (route === "/control/judge-tokens" && method === "POST") {
    const body = objectBody(req);
    const label = requiredString(body.label, "label", 128);
    const expiresAt = optionalIsoDate(body.expiresAt);
    const maxUses = optionalPositiveInteger(body.maxUses, "maxUses", 1_000_000);
    const token = `lhic_judge_${randomBytes(32).toString("base64url")}`;
    const row = await tables.createRow({
      databaseId: config.databaseId,
      tableId: config.judgeTokensTableId,
      rowId: ID.unique(),
      data: {
        label,
        tokenHash: sha256(token),
        expiresAt: expiresAt ?? null,
        maxUses: maxUses ?? null,
        useCount: 0,
        revokedAt: null,
      },
    });
    await audit(tables, config, user.$id, "judge-token.create", row.$id, {
      maxUses: maxUses ?? null,
    });
    return res.json({ token, metadata: publicJudgeToken(row) }, 201);
  }
  const judgeTokenRevokeMatch = route.match(
    /^\/control\/judge-tokens\/([^/]+)\/revoke$/,
  );
  if (judgeTokenRevokeMatch && method === "PATCH") {
    const revokedAt = new Date().toISOString();
    const row = await tables.updateRow({
      databaseId: config.databaseId,
      tableId: config.judgeTokensTableId,
      rowId: judgeTokenRevokeMatch[1],
      data: { revokedAt },
    });
    await audit(tables, config, user.$id, "judge-token.revoke", row.$id);
    return res.json({ metadata: publicJudgeToken(row) });
  }

  if (route === "/control/skills" && method === "GET") {
    return res.json({
      skills: (await listRows(tables, config, config.skillsTableId)).map(
        publicAdminSkill,
      ),
    });
  }
  const skillStatusMatch = route.match(/^\/control\/skills\/([^/]+)\/status$/);
  if (skillStatusMatch && method === "PATCH") {
    const status = requiredString(objectBody(req).status, "status", 16);
    if (!skillStatuses.has(status))
      throw httpError(400, "Skill status is invalid.");
    const row = await tables.updateRow({
      databaseId: config.databaseId,
      tableId: config.skillsTableId,
      rowId: skillStatusMatch[1],
      data: { status },
    });
    await audit(tables, config, user.$id, "skill.status", skillStatusMatch[1], {
      status,
    });
    return res.json({ skill: publicAdminSkill(row) });
  }

  if (route === "/control/policy-packages" && method === "GET") {
    return res.json({
      policyPackages: (
        await listRows(tables, config, config.policyPackagesTableId)
      ).map(publicPolicyPackage),
    });
  }
  const policyPackageStatusMatch = route.match(
    /^\/control\/policy-packages\/([^/]+)\/status$/,
  );
  if (policyPackageStatusMatch && method === "PATCH") {
    const status = requiredString(objectBody(req).status, "status", 16);
    if (!skillStatuses.has(status) || status === "pending") {
      throw httpError(400, "Policy package status is invalid.");
    }
    const row = await tables.updateRow({
      databaseId: config.databaseId,
      tableId: config.policyPackagesTableId,
      rowId: policyPackageStatusMatch[1],
      data: { status },
    });
    await audit(
      tables,
      config,
      user.$id,
      "policy-package.status",
      policyPackageStatusMatch[1],
      { status },
    );
    return res.json({ policyPackage: publicPolicyPackage(row) });
  }

  if (route === "/control/demo-keys" && method === "GET") {
    const rows = await listRows(tables, config, config.demoKeysTableId);
    return res.json({ keys: rows.map(publicDemoKey) });
  }
  if (route === "/control/demo-keys" && method === "POST") {
    const body = objectBody(req);
    const label = requiredString(body.label, "label", 128);
    const scopes = validateScopes(body.scopes);
    const expiresAt = optionalIsoDate(body.expiresAt);
    const maxUses = optionalPositiveInteger(body.maxUses, "maxUses", 1_000_000);
    const rawKey = `lhic_demo_${randomBytes(32).toString("base64url")}`;
    const row = await tables.createRow({
      databaseId: config.databaseId,
      tableId: config.demoKeysTableId,
      rowId: ID.unique(),
      data: {
        label,
        keyHash: sha256(rawKey),
        scopes: JSON.stringify(scopes),
        expiresAt: expiresAt ?? null,
        maxUses: maxUses ?? null,
        useCount: 0,
        revokedAt: null,
      },
    });
    await audit(tables, config, user.$id, "demo-key.create", row.$id, {
      scopes,
    });
    return res.json({ key: rawKey, metadata: publicDemoKey(row) }, 201);
  }
  const revokeMatch = route.match(/^\/control\/demo-keys\/([^/]+)\/revoke$/);
  if (revokeMatch && method === "PATCH") {
    const revokedAt = new Date().toISOString();
    const row = await tables.updateRow({
      databaseId: config.databaseId,
      tableId: config.demoKeysTableId,
      rowId: revokeMatch[1],
      data: { revokedAt },
    });
    await audit(tables, config, user.$id, "demo-key.revoke", revokeMatch[1]);
    return res.json({ metadata: publicDemoKey(row) });
  }

  if (route === "/control/secrets" && method === "GET") {
    const rows = await listRows(tables, config, config.secretsTableId);
    return res.json({ secrets: rows.map(publicSecret) });
  }
  if (route === "/control/secrets" && method === "POST") {
    const body = objectBody(req);
    const label = requiredString(body.label, "label", 128);
    const kind = requiredString(body.kind, "kind", 64);
    const secret = requiredString(body.secret, "secret", 12_000);
    const envelope = encryptSecret(secret, config.secretEncryptionKey);
    const row = await tables.createRow({
      databaseId: config.databaseId,
      tableId: config.secretsTableId,
      rowId: ID.unique(),
      data: {
        label,
        kind,
        envelope: JSON.stringify(envelope),
        keyVersion: "v1",
        revokedAt: null,
      },
    });
    await audit(tables, config, user.$id, "secret.create", row.$id, { kind });
    return res.json({ secret: publicSecret(row) }, 201);
  }
  const secretRevokeMatch = route.match(
    /^\/control\/secrets\/([^/]+)\/revoke$/,
  );
  if (secretRevokeMatch && method === "PATCH") {
    const revokedAt = new Date().toISOString();
    const row = await tables.updateRow({
      databaseId: config.databaseId,
      tableId: config.secretsTableId,
      rowId: secretRevokeMatch[1],
      data: { revokedAt },
    });
    await audit(
      tables,
      config,
      user.$id,
      "secret.revoke",
      secretRevokeMatch[1],
    );
    return res.json({ secret: publicSecret(row) });
  }

  if (route === "/control/assets" && method === "GET") {
    const rows = await listRows(tables, config, config.assetsTableId);
    return res.json({ assets: rows.map(publicAsset) });
  }
  if (route === "/control/assets" && method === "POST") {
    const body = objectBody(req);
    const asset = validateAsset(body);
    const row = await tables.createRow({
      databaseId: config.databaseId,
      tableId: config.assetsTableId,
      rowId: ID.unique(),
      data: {
        ...asset,
        metadata: JSON.stringify(asset.metadata),
        retiredAt: null,
      },
    });
    await audit(tables, config, user.$id, "demo-asset.create", row.$id, {
      kind: asset.kind,
      generatedAt: asset.generatedAt,
    });
    return res.json({ asset: publicAsset(row) }, 201);
  }
  const assetRetireMatch = route.match(/^\/control\/assets\/([^/]+)\/retire$/);
  if (assetRetireMatch && method === "PATCH") {
    const retiredAt = new Date().toISOString();
    const row = await tables.updateRow({
      databaseId: config.databaseId,
      tableId: config.assetsTableId,
      rowId: assetRetireMatch[1],
      data: { retiredAt },
    });
    await audit(
      tables,
      config,
      user.$id,
      "demo-asset.retire",
      assetRetireMatch[1],
    );
    return res.json({ asset: publicAsset(row) });
  }

  return res.json({ error: "Not found." }, 404);
}

export function controlConfigFromEnvironment(environment = process.env) {
  const required = (name) => {
    const value = environment[name];
    if (!value?.trim()) throw httpError(500, `${name} is not configured.`);
    return value;
  };
  return {
    rolesTableId: required("LHIC_CONTROL_ROLES_TABLE_ID"),
    judgesTableId: required("LHIC_CONTROL_JUDGES_TABLE_ID"),
    judgeEmailsTableId: required("LHIC_CONTROL_JUDGE_EMAILS_TABLE_ID"),
    judgeTokensTableId: required("LHIC_CONTROL_JUDGE_TOKENS_TABLE_ID"),
    demoKeysTableId: required("LHIC_CONTROL_DEMO_KEYS_TABLE_ID"),
    secretsTableId: required("LHIC_CONTROL_SECRETS_TABLE_ID"),
    auditTableId: required("LHIC_CONTROL_AUDIT_TABLE_ID"),
    assetsTableId: required("LHIC_CONTROL_DEMO_ASSETS_TABLE_ID"),
    policyPackagesTableId: required("LHIC_CONTROL_POLICY_PACKAGES_TABLE_ID"),
    bootstrapAdminAccountId: required("LHIC_BOOTSTRAP_ADMIN_ACCOUNT_ID"),
    secretEncryptionKey: requiredEncryptionKey(
      environment.LHIC_SECRET_ENCRYPTION_KEY,
    ),
  };
}

export function validateGithubUserId(value) {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
    throw httpError(400, "GitHub user IDs must be immutable numeric IDs.");
  }
  return value;
}

export function validateGithubEmail(value) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
  ) {
    throw httpError(400, "GitHub email is invalid.");
  }
  return value.trim().toLowerCase();
}

export function createDemoApiKey() {
  const value = `lhic_demo_${randomBytes(32).toString("base64url")}`;
  return { value, hash: sha256(value) };
}

export function encryptSecret(secret, encodedKey) {
  const key = Buffer.isBuffer(encodedKey)
    ? encodedKey
    : requiredEncryptionKey(encodedKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

async function requireAdmin(tables, config, accountId) {
  if (!(await isAdmin(tables, config, accountId))) {
    throw httpError(403, "An administrator role is required.");
  }
}

async function isAdmin(tables, config, accountId) {
  if (accountId === config.bootstrapAdminAccountId) return true;
  const result = await tables.listRows({
    databaseId: config.databaseId,
    tableId: config.rolesTableId,
    queries: [
      Query.equal("accountId", accountId),
      Query.equal("role", "admin"),
      Query.equal("active", true),
      Query.limit(1),
    ],
    total: false,
  });
  return result.rows.length === 1;
}

async function judgeAccess(tables, config, github, token) {
  if (token) {
    const tokenGrant = await consumeJudgeToken(tables, config, token);
    return tokenGrant
      ? {
          allowed: true,
          authentication: "token",
          subject: `Issued token: ${String(tokenGrant.label)}`,
        }
      : undefined;
  }
  if (!github || !(await isJudge(tables, config, github))) return undefined;
  return {
    allowed: true,
    authentication: "github",
    subject: github.providerEmail
      ? "GitHub email allowlist"
      : "GitHub numeric-ID allowlist",
    ...(github.githubUserId ? { githubUserId: github.githubUserId } : {}),
  };
}

async function requireJudgeAccess(tables, config, identity, token) {
  const access = await judgeAccess(tables, config, await identity(), token?.());
  if (!access) {
    throw httpError(
      403,
      "A GitHub allowlisted email or administrator-issued judge token is required.",
    );
  }
  return access;
}

async function isJudge(tables, config, github) {
  const checks = [];
  if (github.githubUserId) {
    checks.push(
      activeJudgeMatch(
        tables,
        config,
        config.judgesTableId,
        "githubUserId",
        github.githubUserId,
      ),
    );
  }
  if (github.providerEmail) {
    checks.push(
      activeJudgeMatch(
        tables,
        config,
        config.judgeEmailsTableId,
        "githubEmail",
        validateGithubEmail(github.providerEmail),
      ),
    );
  }
  return (await Promise.all(checks)).some(Boolean);
}

async function activeJudgeMatch(tables, config, tableId, column, value) {
  const result = await tables.listRows({
    databaseId: config.databaseId,
    tableId,
    queries: [
      Query.equal(column, value),
      Query.equal("active", true),
      Query.limit(1),
    ],
    total: false,
  });
  const judge = result.rows[0];
  return Boolean(
    judge &&
    (!judge.expiresAt || Date.parse(String(judge.expiresAt)) > Date.now()),
  );
}

async function consumeJudgeToken(tables, config, token) {
  if (
    typeof token !== "string" ||
    !/^lhic_judge_[A-Za-z0-9_-]{32,}$/.test(token)
  ) {
    return undefined;
  }
  const result = await tables.listRows({
    databaseId: config.databaseId,
    tableId: config.judgeTokensTableId,
    queries: [Query.equal("tokenHash", sha256(token)), Query.limit(1)],
    total: false,
  });
  const row = result.rows[0];
  if (
    !row ||
    row.revokedAt ||
    (row.expiresAt && Date.parse(String(row.expiresAt)) <= Date.now()) ||
    (Number.isFinite(Number(row.maxUses)) &&
      Number(row.useCount) >= Number(row.maxUses))
  ) {
    return undefined;
  }
  await tables.updateRow({
    databaseId: config.databaseId,
    tableId: config.judgeTokensTableId,
    rowId: row.$id,
    data: { useCount: Number(row.useCount) + 1 },
  });
  return row;
}

async function listRows(tables, config, tableId) {
  const rows = [];
  let cursor;
  do {
    const result = await tables.listRows({
      databaseId: config.databaseId,
      tableId,
      queries: [
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

async function audit(tables, config, actorId, action, target, metadata = {}) {
  await tables.createRow({
    databaseId: config.databaseId,
    tableId: config.auditTableId,
    rowId: ID.unique(),
    data: { actorId, action, target, metadata: JSON.stringify(metadata) },
  });
}

function publicDemoKey(row) {
  return {
    id: row.$id,
    label: String(row.label),
    scopes: parseArray(row.scopes),
    ...(row.expiresAt ? { expiresAt: String(row.expiresAt) } : {}),
    ...(Number.isFinite(Number(row.maxUses))
      ? { maxUses: Number(row.maxUses) }
      : {}),
    ...(row.revokedAt ? { revokedAt: String(row.revokedAt) } : {}),
    createdAt: String(row.$createdAt),
  };
}

function publicJudge(row, kind) {
  return {
    id: `${kind}:${row.$id}`,
    kind,
    label: String(row.label),
    active: row.active === true,
    ...(kind === "github-user-id"
      ? { githubUserId: String(row.githubUserId) }
      : { githubEmail: String(row.githubEmail) }),
    ...(row.expiresAt ? { expiresAt: String(row.expiresAt) } : {}),
  };
}

function publicJudgeToken(row) {
  return {
    id: row.$id,
    label: String(row.label),
    ...(row.expiresAt ? { expiresAt: String(row.expiresAt) } : {}),
    ...(Number.isFinite(Number(row.maxUses))
      ? { maxUses: Number(row.maxUses) }
      : {}),
    ...(row.revokedAt ? { revokedAt: String(row.revokedAt) } : {}),
    createdAt: String(row.$createdAt),
  };
}

function publicAdminSkill(row) {
  return {
    id: row.$id,
    name: String(row.name),
    version: String(row.version),
    status: String(row.status),
    fastPathEligible: row.fastPathEligible === true,
    updatedAt: String(row.$updatedAt),
  };
}

function publicSecret(row) {
  return {
    id: row.$id,
    label: String(row.label),
    kind: String(row.kind),
    keyVersion: String(row.keyVersion),
    ...(row.revokedAt ? { revokedAt: String(row.revokedAt) } : {}),
    createdAt: String(row.$createdAt),
  };
}

function publicAsset(row) {
  return {
    id: row.$id,
    title: String(row.title),
    kind: String(row.kind),
    sourceUrl: String(row.sourceUrl),
    generatedAt: String(row.generatedAt),
    sha256: String(row.sha256),
    metadata: parseObject(row.metadata),
    ...(row.retiredAt ? { retiredAt: String(row.retiredAt) } : {}),
    createdAt: String(row.$createdAt),
  };
}

function publicPolicyPackage(row) {
  return {
    id: row.$id,
    packageId: String(row.packageId),
    core: String(row.core),
    profileId: String(row.profileId),
    bundleUrl: String(row.bundleUrl),
    bundleSha256: String(row.bundleSha256),
    manifestSha256: String(row.manifestSha256),
    weightsSha256: String(row.weightsSha256),
    actionCodec: String(row.actionCodec),
    ...(row.evaluationReportSha256
      ? { evaluationReportSha256: String(row.evaluationReportSha256) }
      : {}),
    version: String(row.version),
    status: String(row.status),
    createdAt: String(row.$createdAt),
    updatedAt: String(row.$updatedAt ?? row.$createdAt),
  };
}

function isActiveAsset(row) {
  return !row.retiredAt;
}

function objectBody(req) {
  try {
    const body = JSON.parse(String(req.body ?? ""));
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    throw httpError(400, "Control request body must be a JSON object.");
  }
}

function validateJudgeGrant(value) {
  const hasGithubUserId =
    value.githubUserId !== undefined && value.githubUserId !== "";
  const hasGithubEmail =
    value.githubEmail !== undefined && value.githubEmail !== "";
  if (hasGithubUserId === hasGithubEmail) {
    throw httpError(
      400,
      "Provide exactly one GitHub numeric ID or GitHub email for a judge grant.",
    );
  }
  return hasGithubUserId
    ? {
        kind: "github-user-id",
        value: validateGithubUserId(value.githubUserId),
      }
    : { kind: "github-email", value: validateGithubEmail(value.githubEmail) };
}

function parseJudgeGrantId(value) {
  const match = /^(github-user-id|github-email):([A-Za-z0-9._-]{1,36})$/.exec(
    String(value),
  );
  if (!match) throw httpError(400, "Judge grant ID is invalid.");
  return { kind: match[1], rowId: match[2] };
}

function requiredString(value, name, maximum) {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw httpError(400, `${name} is invalid.`);
  }
  return value.trim();
}

function validateScopes(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 16 ||
    !value.every(
      (scope) => typeof scope === "string" && keyScopePattern.test(scope),
    )
  ) {
    throw httpError(400, "Demo key scopes are invalid.");
  }
  return [...new Set(value)].sort();
}

function optionalIsoDate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw httpError(400, "expiresAt must be an ISO date.");
  }
  return new Date(value).toISOString();
}

function optionalPositiveInteger(value, name, maximum) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw httpError(400, `${name} is invalid.`);
  }
  return value;
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function validateAsset(value) {
  const title = requiredString(value.title, "title", 160);
  const kind = requiredString(value.kind, "kind", 24);
  if (!assetKinds.has(kind)) throw httpError(400, "Asset kind is invalid.");
  const sourceUrl = requiredHttpsUrl(value.sourceUrl, "sourceUrl", 2_048);
  const generatedAt = requiredIsoDate(value.generatedAt, "generatedAt");
  const sha256 = requiredString(value.sha256, "sha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw httpError(400, "sha256 must be a SHA-256 digest.");
  }
  return {
    title,
    kind,
    sourceUrl,
    generatedAt,
    sha256,
    metadata: sanitizeMetadata(value.metadata),
  };
}

function validatePolicyPackage(value) {
  const allowed = new Set([
    "packageId",
    "core",
    "profileId",
    "bundleUrl",
    "bundleSha256",
    "manifestSha256",
    "weightsSha256",
    "actionCodec",
    "evaluationReportSha256",
    "version",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw httpError(400, "Policy package metadata contains unsupported data.");
  }
  const packageId = requiredSha256(value.packageId, "packageId");
  const core = requiredString(value.core, "core", 4);
  if (core !== "2d" && core !== "3d") {
    throw httpError(400, "Policy package core is invalid.");
  }
  return {
    packageId,
    core,
    profileId: requiredString(value.profileId, "profileId", 128),
    bundleUrl: requiredHttpsUrl(value.bundleUrl, "bundleUrl", 2_048),
    bundleSha256: requiredSha256(value.bundleSha256, "bundleSha256"),
    manifestSha256: requiredSha256(value.manifestSha256, "manifestSha256"),
    weightsSha256: requiredSha256(value.weightsSha256, "weightsSha256"),
    actionCodec: requiredString(value.actionCodec, "actionCodec", 128),
    ...(value.evaluationReportSha256 === undefined
      ? {}
      : {
          evaluationReportSha256: requiredSha256(
            value.evaluationReportSha256,
            "evaluationReportSha256",
          ),
        }),
    version: requiredString(value.version, "version", 64),
  };
}

function requiredSha256(value, name) {
  const digest = requiredString(value, name, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw httpError(400, `${name} must be a SHA-256 digest.`);
  }
  return digest;
}

function requiredHttpsUrl(value, name, maximum) {
  const raw = requiredString(value, name, maximum);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, `${name} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw httpError(400, `${name} must be a credential-free HTTPS URL.`);
  }
  return url.toString();
}

function requiredIsoDate(value, name) {
  const parsed = optionalIsoDate(value);
  if (!parsed) throw httpError(400, `${name} must be an ISO date.`);
  return parsed;
}

function sanitizeMetadata(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "Asset metadata must be an object.");
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 8_192) {
    throw httpError(400, "Asset metadata is too large.");
  }
  return sanitizeMetadataValue(value);
}

function sanitizeMetadataValue(value) {
  if (typeof value === "string") return value.slice(0, 1_024);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeMetadataValue);
  if (!value || typeof value !== "object") {
    throw httpError(400, "Asset metadata contains an unsupported value.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) {
        throw httpError(400, "Asset metadata contains an invalid key.");
      }
      if (/(secret|token|password|cookie|credential|api[_-]?key)/i.test(key)) {
        throw httpError(400, "Asset metadata may not contain credentials.");
      }
      return [key, sanitizeMetadataValue(item)];
    }),
  );
}

function requiredEncryptionKey(value) {
  const key = Buffer.from(String(value ?? ""), "base64");
  if (key.length !== 32) {
    throw httpError(
      500,
      "LHIC_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key.",
    );
  }
  return key;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
