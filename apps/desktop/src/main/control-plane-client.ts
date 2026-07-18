import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import {
  KeyringSharedSkillCredentialStore,
  readSharedSkillsConfig,
  type SharedSkillCredentialStore,
  type SharedSkillsConfig,
} from "@lhic/shared-skills";

import type {
  AdminControlSnapshot,
  AdminJudgeGrant,
  AdminSecretMetadata,
  AdminSession,
  AdminSkillReview,
  DemoApiKeyMetadata,
  JudgeAuthTokenMetadata,
  JudgeDemoAsset,
  JudgeLoginState,
  JudgeSession,
  PolicyPackageSubmission,
  SharedPolicyPackage,
} from "../shared/contracts.js";
import { bakedSharedSkillsConfig } from "./appwrite-public-config.js";

const databaseFile = ".lhic/skills.sqlite";
const githubLoginLifetimeMs = 5 * 60_000;

interface PendingGithubLogin {
  config: SharedSkillsConfig;
  deviceCode: string;
  expiresAt: number;
}

export interface ControlPlaneClientOptions {
  databasePath?: string;
  fetchImplementation?: typeof fetch;
  credentialStore?: SharedSkillCredentialStore;
  openExternal?: (url: string) => Promise<void>;
  judgeTokenStore?: {
    get(id: string): Promise<string | undefined>;
    set(id: string, secret: string): Promise<void>;
    remove?(id: string): Promise<void>;
  };
}

/**
 * Small authenticated client for the Appwrite Function control plane. It keeps
 * the session cookie in Keychain and exchanges it for a short-lived JWT per
 * request, never exposing either value through IPC.
 */
export class ControlPlaneClient {
  private readonly databasePath: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly credentialStore: SharedSkillCredentialStore;
  private readonly judgeTokenStore: ControlPlaneClientOptions["judgeTokenStore"];
  private pendingGithubLogin: PendingGithubLogin | undefined;

  public constructor(
    workspaceRoot: string,
    private readonly options: ControlPlaneClientOptions = {},
  ) {
    this.databasePath = resolve(
      workspaceRoot,
      options.databasePath ?? databaseFile,
    );
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.credentialStore =
      options.credentialStore ?? new KeyringSharedSkillCredentialStore();
    this.judgeTokenStore = options.judgeTokenStore;
  }

  public async beginGithubLogin(): Promise<JudgeLoginState> {
    const config = await this.requiredConfig();
    const deviceCode = randomBytes(32).toString("base64url");
    const callback = new URL(`${config.functionUrl}/auth/callback`);
    callback.searchParams.set("device", deviceCode);
    const oauth = new URL(`${config.endpoint}/account/sessions/oauth2/github`);
    oauth.searchParams.set("project", config.projectId);
    oauth.searchParams.set("success", callback.toString());
    this.pendingGithubLogin = {
      config,
      deviceCode,
      expiresAt: Date.now() + githubLoginLifetimeMs,
    };
    const openExternal = this.options.openExternal;
    if (!openExternal) {
      throw new Error("The desktop shell cannot open the GitHub sign-in flow.");
    }
    await openExternal(oauth.toString());
    return {
      status: "pending",
      expiresAt: new Date(this.pendingGithubLogin.expiresAt).toISOString(),
      message:
        "GitHub sign-in opened in the system browser. Complete it, then check judge access here.",
    };
  }

  public async pollGithubLogin(): Promise<JudgeLoginState> {
    const pending = this.pendingGithubLogin;
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pendingGithubLogin = undefined;
      throw new Error(
        "Start a new GitHub sign-in request before checking access.",
      );
    }
    const callback = new URL(`${pending.config.functionUrl}/auth/poll`);
    callback.searchParams.set("device", pending.deviceCode);
    const response = await this.fetchImplementation(callback, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const payload = await readJson(response, "GitHub sign-in status");
    if (payload.status === "pending") {
      return {
        status: "pending",
        expiresAt: new Date(pending.expiresAt).toISOString(),
        message: "Waiting for the GitHub OAuth callback.",
      };
    }
    if (
      payload.status !== "complete" ||
      typeof payload.userId !== "string" ||
      typeof payload.secret !== "string"
    ) {
      throw new Error("GitHub sign-in returned an invalid device response.");
    }
    const cookie = await this.createSession(
      pending.config,
      payload.userId,
      payload.secret,
    );
    await this.credentialStore.set(pending.config, cookie);
    await this.judgeTokenStore?.remove?.(
      judgeTokenCredentialId(pending.config),
    );
    this.pendingGithubLogin = undefined;
    const judge = await this.judgeSession();
    return {
      status: "complete",
      expiresAt: new Date(pending.expiresAt).toISOString(),
      message: `Judge Center unlocked through ${judge.subject}.`,
    };
  }

  public async judgeSession(): Promise<JudgeSession> {
    const payload = await this.request("/control/judge/session");
    if (
      typeof payload.subject !== "string" ||
      !["github", "token"].includes(payload.authentication as string) ||
      payload.allowed !== true
    ) {
      throw new Error("Judge Center returned an invalid access response.");
    }
    return {
      subject: payload.subject,
      authentication: payload.authentication as JudgeSession["authentication"],
      ...(typeof payload.githubUserId === "string"
        ? { githubUserId: payload.githubUserId }
        : {}),
      allowed: true,
    };
  }

  public async authorizeJudgeToken(token: string): Promise<JudgeSession> {
    const normalized = token.trim();
    if (!/^lhic_judge_[A-Za-z0-9_-]{32,}$/.test(normalized)) {
      throw new Error("Judge authorization token is invalid.");
    }
    const payload = await this.request("/control/judge/session", {
      judgeToken: normalized,
    });
    const session = parseJudgeSession(payload);
    const config = await this.requiredConfig();
    await this.judgeTokenStore?.set(judgeTokenCredentialId(config), normalized);
    return session;
  }

  public async judgeCatalog(): Promise<JudgeDemoAsset[]> {
    const payload = await this.request("/control/judge/catalog");
    if (!Array.isArray(payload.assets)) {
      throw new Error("Judge evidence catalog returned an invalid response.");
    }
    return payload.assets.map(parseJudgeAsset);
  }

  public async judgePolicyPackages(): Promise<SharedPolicyPackage[]> {
    const payload = await this.request("/control/judge/policy-packages");
    return parseArray(payload.policyPackages, parseSharedPolicyPackage);
  }

  public async adminSnapshot(): Promise<AdminControlSnapshot> {
    const session = parseAdminSession(await this.request("/control/session"));
    const [
      judges,
      judgeTokens,
      skills,
      demoKeys,
      secrets,
      assets,
      policyPackages,
    ] = await Promise.all([
      this.request("/control/judges"),
      this.request("/control/judge-tokens"),
      this.request("/control/skills"),
      this.request("/control/demo-keys"),
      this.request("/control/secrets"),
      this.request("/control/assets"),
      this.request("/control/policy-packages"),
    ]);
    return {
      session,
      judges: parseArray(judges.judges, parseAdminJudge),
      judgeTokens: parseArray(judgeTokens.tokens, parseJudgeToken),
      skills: parseArray(skills.skills, parseAdminSkill),
      demoKeys: parseArray(demoKeys.keys, parseDemoKey),
      secrets: parseArray(secrets.secrets, parseSecretMetadata),
      assets: parseArray(assets.assets, parseJudgeAsset),
      policyPackages: parseArray(
        policyPackages.policyPackages,
        parseSharedPolicyPackage,
      ),
    };
  }

  public async createJudge(input: {
    kind: "github-user-id" | "github-email";
    githubUserId?: string;
    githubEmail?: string;
    label: string;
    expiresAt?: string;
  }): Promise<AdminJudgeGrant> {
    return parseAdminJudge(
      await this.request("/control/judges", { method: "POST", body: input }),
    );
  }

  public async revokeJudge(id: string): Promise<AdminJudgeGrant> {
    const response = await this.request(
      `/control/judges/${encodePath(id)}/revoke`,
      { method: "PATCH" },
    );
    return parseAdminJudge(response.judge);
  }

  public async createJudgeToken(input: {
    label: string;
    expiresAt?: string;
    maxUses?: number;
  }): Promise<{ token: string; metadata: JudgeAuthTokenMetadata }> {
    const response = await this.request("/control/judge-tokens", {
      method: "POST",
      body: input,
    });
    if (typeof response.token !== "string" || !response.token) {
      throw new Error("Judge authorization token response is invalid.");
    }
    return {
      token: response.token,
      metadata: parseJudgeToken(response.metadata),
    };
  }

  public async revokeJudgeToken(id: string): Promise<JudgeAuthTokenMetadata> {
    const response = await this.request(
      `/control/judge-tokens/${encodePath(id)}/revoke`,
      { method: "PATCH" },
    );
    const metadata = parseJudgeToken(response.metadata);
    if (!metadata.revokedAt) {
      throw new Error(
        "Judge authorization token revocation response is invalid.",
      );
    }
    return metadata;
  }

  public async setSkillStatus(
    id: string,
    status: "approved" | "rejected" | "revoked",
  ): Promise<AdminSkillReview> {
    const response = await this.request(
      `/control/skills/${encodePath(id)}/status`,
      { method: "PATCH", body: { status } },
    );
    const skill = parseAdminSkill(response.skill);
    if (skill.status !== status) {
      throw new Error(
        "Skill review response does not match the requested status.",
      );
    }
    return skill;
  }

  public async submitPolicyPackage(
    input: PolicyPackageSubmission,
  ): Promise<SharedPolicyPackage> {
    const policy = input.package;
    const response = await this.request("/control/policy-packages", {
      method: "POST",
      body: {
        packageId: policy.packageId,
        core: policy.core,
        profileId: policy.profileId,
        bundleUrl: input.bundleUrl,
        bundleSha256: policy.bundleSha256,
        manifestSha256: policy.manifestSha256,
        weightsSha256: policy.weightsSha256,
        actionCodec: policy.actionCodec,
        ...(policy.evaluationReportSha256
          ? { evaluationReportSha256: policy.evaluationReportSha256 }
          : {}),
        version: input.version,
      },
    });
    return parseSharedPolicyPackage(response.policyPackage);
  }

  public async setPolicyPackageStatus(
    id: string,
    status: "approved" | "rejected" | "revoked",
  ): Promise<SharedPolicyPackage> {
    const response = await this.request(
      `/control/policy-packages/${encodePath(id)}/status`,
      { method: "PATCH", body: { status } },
    );
    const policyPackage = parseSharedPolicyPackage(response.policyPackage);
    if (policyPackage.status !== status) {
      throw new Error(
        "Policy package review response does not match the requested status.",
      );
    }
    return policyPackage;
  }

  public async createDemoKey(input: {
    label: string;
    scopes: string[];
    expiresAt?: string;
    maxUses?: number;
  }): Promise<{ key: string; metadata: DemoApiKeyMetadata }> {
    const response = await this.request("/control/demo-keys", {
      method: "POST",
      body: input,
    });
    if (typeof response.key !== "string" || !response.key) {
      throw new Error("Demo API key response is invalid.");
    }
    return { key: response.key, metadata: parseDemoKey(response.metadata) };
  }

  public async revokeDemoKey(id: string): Promise<DemoApiKeyMetadata> {
    const response = await this.request(
      `/control/demo-keys/${encodePath(id)}/revoke`,
      { method: "PATCH" },
    );
    const metadata = parseDemoKey(response.metadata);
    if (!metadata.revokedAt) {
      throw new Error("Demo API key revocation response is invalid.");
    }
    return metadata;
  }

  public async createSecret(input: {
    label: string;
    kind: string;
    secret: string;
  }): Promise<AdminSecretMetadata> {
    const response = await this.request("/control/secrets", {
      method: "POST",
      body: input,
    });
    return parseSecretMetadata(response.secret);
  }

  public async revokeSecret(id: string): Promise<AdminSecretMetadata> {
    const response = await this.request(
      `/control/secrets/${encodePath(id)}/revoke`,
      { method: "PATCH" },
    );
    const secret = parseSecretMetadata(response.secret);
    if (!secret.revokedAt) {
      throw new Error("Secret revocation response is invalid.");
    }
    return secret;
  }

  public async createAsset(
    input: Omit<JudgeDemoAsset, "id" | "createdAt">,
  ): Promise<JudgeDemoAsset> {
    const response = await this.request("/control/assets", {
      method: "POST",
      body: input,
    });
    return parseJudgeAsset(response.asset);
  }

  public async retireAsset(id: string): Promise<JudgeDemoAsset> {
    const response = await this.request(
      `/control/assets/${encodePath(id)}/retire`,
      { method: "PATCH" },
    );
    const asset = parseJudgeAsset(response.asset);
    if (!asset.retiredAt) {
      throw new Error("Demo asset retirement response is invalid.");
    }
    return asset;
  }

  private async request(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH";
      body?: object;
      judgeToken?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const config = await this.requiredConfig();
    const cookie = await this.credentialStore.get(config);
    const token =
      options.judgeToken ??
      (isJudgeRoute(path)
        ? await this.judgeTokenStore?.get(judgeTokenCredentialId(config))
        : undefined);
    if (!cookie && !token) {
      throw new Error(
        "Sign in with GitHub or enter an administrator-issued judge token before accessing Judge Center.",
      );
    }
    const jwt =
      cookie && !token ? await this.createJwt(config, cookie) : undefined;
    const response = await this.fetchImplementation(
      `${config.functionUrl}${path}`,
      {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          "X-Appwrite-Project": config.projectId,
          ...(jwt ? { "X-Appwrite-User-JWT": jwt } : {}),
          ...(token ? { "X-LHIC-Judge-Token": token } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    return readJson(response, "Control plane request");
  }

  private async createJwt(
    config: SharedSkillsConfig,
    cookie: string,
  ): Promise<string> {
    const response = await this.fetchImplementation(
      `${config.endpoint}/account/jwt`,
      {
        method: "POST",
        headers: {
          "X-Appwrite-Project": config.projectId,
          Cookie: cookie,
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const payload = await readJson(response, "Appwrite session");
    if (typeof payload.jwt !== "string" || !payload.jwt) {
      throw new Error("Appwrite session did not return a JWT.");
    }
    return payload.jwt;
  }

  private async createSession(
    config: SharedSkillsConfig,
    userId: string,
    secret: string,
  ): Promise<string> {
    const response = await this.fetchImplementation(
      `${config.endpoint}/account/sessions/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": config.projectId,
        },
        body: JSON.stringify({ userId, secret }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    await readJson(response, "GitHub session creation");
    const cookies = getSetCookies(response.headers)
      .map((value) => value.split(";", 1)[0] ?? "")
      .filter(Boolean);
    if (cookies.length === 0) {
      throw new Error(
        "GitHub session creation did not return a session cookie.",
      );
    }
    return cookies.join("; ");
  }

  private async requiredConfig(): Promise<SharedSkillsConfig> {
    const config =
      (await readSharedSkillsConfig(this.databasePath)) ??
      bakedSharedSkillsConfig;
    if (!config.enabled) throw new Error("Shared Skills are disabled locally.");
    return config;
  }
}

async function readJson(
  response: Response,
  label: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  try {
    const value = (await response.json()) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

function getSetCookies(headers: Headers): string[] {
  const extendedHeaders = headers as Headers & {
    getSetCookie?: () => string[];
  };
  return (
    extendedHeaders.getSetCookie?.() ??
    (headers.get("set-cookie") ? [headers.get("set-cookie")!] : [])
  );
}

function isJudgeRoute(path: string): boolean {
  return (
    path === "/control/judge/session" || path.startsWith("/control/judge/")
  );
}

function judgeTokenCredentialId(config: SharedSkillsConfig): string {
  return `judge-token:${config.projectId}:${config.functionUrl}`;
}

function parseJudgeAsset(value: unknown): JudgeDemoAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Judge evidence catalog contains an invalid asset.");
  }
  const asset = value as Record<string, unknown>;
  const kind = asset.kind;
  if (
    !["benchmark", "trace", "presentation", "guide", "report"].includes(
      kind as string,
    ) ||
    !["id", "title", "sourceUrl", "generatedAt", "sha256", "createdAt"].every(
      (key) => typeof asset[key] === "string" && Boolean(asset[key]),
    ) ||
    !asset.metadata ||
    typeof asset.metadata !== "object" ||
    Array.isArray(asset.metadata)
  ) {
    throw new Error("Judge evidence catalog contains an invalid asset.");
  }
  return {
    id: asset.id as string,
    title: asset.title as string,
    kind: kind as JudgeDemoAsset["kind"],
    sourceUrl: asset.sourceUrl as string,
    generatedAt: asset.generatedAt as string,
    sha256: asset.sha256 as string,
    metadata: asset.metadata as Record<string, unknown>,
    createdAt: asset.createdAt as string,
    ...(typeof asset.retiredAt === "string"
      ? { retiredAt: asset.retiredAt }
      : {}),
  };
}

function parseAdminSession(value: Record<string, unknown>): AdminSession {
  if (typeof value.accountId !== "string" || value.admin !== true) {
    throw new Error("Administrator access is required.");
  }
  return {
    accountId: value.accountId,
    admin: true,
    ...(typeof value.githubUserId === "string"
      ? { githubUserId: value.githubUserId }
      : {}),
  };
}

function parseJudgeSession(value: Record<string, unknown>): JudgeSession {
  if (
    typeof value.subject !== "string" ||
    !["github", "token"].includes(value.authentication as string) ||
    value.allowed !== true
  ) {
    throw new Error("Judge Center returned an invalid access response.");
  }
  return {
    subject: value.subject,
    authentication: value.authentication as JudgeSession["authentication"],
    ...(typeof value.githubUserId === "string"
      ? { githubUserId: value.githubUserId }
      : {}),
    allowed: true,
  };
}

function parseAdminJudge(value: unknown): AdminJudgeGrant {
  const record = requiredRecord(value, "Judge grant");
  if (
    !["id", "kind", "label"].every(
      (key) => typeof record[key] === "string" && Boolean(record[key]),
    ) ||
    !["github-user-id", "github-email"].includes(record.kind as string) ||
    typeof record.active !== "boolean"
  ) {
    throw new Error("Judge grant is invalid.");
  }
  const kind = record.kind as AdminJudgeGrant["kind"];
  const identity =
    kind === "github-user-id"
      ? typeof record.githubUserId === "string" && record.githubUserId
        ? { githubUserId: record.githubUserId }
        : undefined
      : typeof record.githubEmail === "string" && record.githubEmail
        ? { githubEmail: record.githubEmail }
        : undefined;
  if (!identity) throw new Error("Judge grant identity is invalid.");
  return {
    id: record.id as string,
    kind,
    label: record.label as string,
    active: record.active,
    ...identity,
    ...(typeof record.expiresAt === "string"
      ? { expiresAt: record.expiresAt }
      : {}),
  };
}

function parseJudgeToken(value: unknown): JudgeAuthTokenMetadata {
  const record = requiredRecord(value, "Judge authorization token");
  if (
    !["id", "label", "createdAt"].every(
      (key) => typeof record[key] === "string" && Boolean(record[key]),
    ) ||
    (record.maxUses !== undefined &&
      (!Number.isSafeInteger(record.maxUses) || Number(record.maxUses) < 1))
  ) {
    throw new Error("Judge authorization token is invalid.");
  }
  return {
    id: record.id as string,
    label: record.label as string,
    createdAt: record.createdAt as string,
    ...(typeof record.expiresAt === "string"
      ? { expiresAt: record.expiresAt }
      : {}),
    ...(typeof record.maxUses === "number" ? { maxUses: record.maxUses } : {}),
    ...(typeof record.revokedAt === "string"
      ? { revokedAt: record.revokedAt }
      : {}),
  };
}

function parseAdminSkill(value: unknown): AdminSkillReview {
  const record = requiredRecord(value, "Shared Skill review");
  if (
    !["id", "name", "version", "status", "updatedAt"].every(
      (key) => typeof record[key] === "string" && Boolean(record[key]),
    ) ||
    !["pending", "approved", "rejected", "revoked"].includes(
      record.status as string,
    ) ||
    typeof record.fastPathEligible !== "boolean"
  ) {
    throw new Error("Shared Skill review is invalid.");
  }
  return {
    id: record.id as string,
    name: record.name as string,
    version: record.version as string,
    status: record.status as AdminSkillReview["status"],
    fastPathEligible: record.fastPathEligible,
    updatedAt: record.updatedAt as string,
  };
}

function parseSharedPolicyPackage(value: unknown): SharedPolicyPackage {
  const record = requiredRecord(value, "Game policy package");
  if (
    ![
      "id",
      "packageId",
      "profileId",
      "bundleUrl",
      "bundleSha256",
      "manifestSha256",
      "weightsSha256",
      "actionCodec",
      "version",
      "status",
      "createdAt",
      "updatedAt",
    ].every((key) => typeof record[key] === "string" && Boolean(record[key])) ||
    !["2d", "3d"].includes(record.core as string) ||
    !["pending", "approved", "rejected", "revoked"].includes(
      record.status as string,
    ) ||
    !["bundleSha256", "manifestSha256", "weightsSha256"].every((key) =>
      /^[a-f0-9]{64}$/.test(record[key] as string),
    ) ||
    (record.evaluationReportSha256 !== undefined &&
      (typeof record.evaluationReportSha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(record.evaluationReportSha256)))
  ) {
    throw new Error("Game policy package is invalid.");
  }
  return {
    id: record.id as string,
    packageId: record.packageId as string,
    core: record.core as SharedPolicyPackage["core"],
    profileId: record.profileId as string,
    bundleUrl: record.bundleUrl as string,
    bundleSha256: record.bundleSha256 as string,
    manifestSha256: record.manifestSha256 as string,
    weightsSha256: record.weightsSha256 as string,
    actionCodec: record.actionCodec as string,
    ...(typeof record.evaluationReportSha256 === "string"
      ? { evaluationReportSha256: record.evaluationReportSha256 }
      : {}),
    version: record.version as string,
    status: record.status as SharedPolicyPackage["status"],
    createdAt: record.createdAt as string,
    updatedAt: record.updatedAt as string,
  };
}

function parseDemoKey(value: unknown): DemoApiKeyMetadata {
  const record = requiredRecord(value, "Demo API key");
  if (
    !["id", "label", "createdAt"].every(
      (key) => typeof record[key] === "string" && Boolean(record[key]),
    ) ||
    !Array.isArray(record.scopes) ||
    !record.scopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("Demo API key metadata is invalid.");
  }
  return {
    id: record.id as string,
    label: record.label as string,
    scopes: [...record.scopes] as string[],
    createdAt: record.createdAt as string,
    ...(typeof record.expiresAt === "string"
      ? { expiresAt: record.expiresAt }
      : {}),
    ...(typeof record.maxUses === "number" ? { maxUses: record.maxUses } : {}),
    ...(typeof record.revokedAt === "string"
      ? { revokedAt: record.revokedAt }
      : {}),
  };
}

function parseSecretMetadata(value: unknown): AdminSecretMetadata {
  const record = requiredRecord(value, "Credential metadata");
  if (
    !["id", "label", "kind", "keyVersion", "createdAt"].every(
      (key) => typeof record[key] === "string" && Boolean(record[key]),
    )
  ) {
    throw new Error("Credential metadata is invalid.");
  }
  return {
    id: record.id as string,
    label: record.label as string,
    kind: record.kind as string,
    keyVersion: record.keyVersion as string,
    createdAt: record.createdAt as string,
    ...(typeof record.revokedAt === "string"
      ? { revokedAt: record.revokedAt }
      : {}),
  };
}

function parseArray<T>(value: unknown, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error("Control plane list is invalid.");
  return value.map(parse);
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function encodePath(value: string): string {
  if (!value || value.length > 128)
    throw new Error("Control plane id is invalid.");
  return encodeURIComponent(value);
}
