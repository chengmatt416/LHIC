import { randomBytes, randomUUID } from "node:crypto";

import type { SharedSkillSnapshot } from "@lhic/memory";

import type { SharedSkillsConfig } from "./config.js";

export interface RegistryUserProfile {
  userId: string;
  displayName: string;
  bio?: string;
  avatarUrl?: string;
}

export interface RegistrySkillSummary {
  id: string;
  version: string;
  name: string;
  operationKey: string;
  fingerprint: string;
  definition: Record<string, unknown>;
  fastPathEligible: boolean;
  contentHash: string;
  description?: string;
  category?: string;
  tags?: string[];
  downloadCount: number;
  ratingAvg: number;
  ratingCount: number;
  authorId: string;
  authorName?: string;
  createdAt?: string;
  updatedAt: string;
}

export interface RegistrySkillVersion {
  version: string;
  contentHash: string;
  changelog?: string;
  createdAt: string;
}

export interface RegistrySkillDetail {
  skill: RegistrySkillSummary;
  versions: RegistrySkillVersion[];
  author?: RegistryUserProfile;
  rating: { avg: number; count: number };
}

export interface RegistrySearchParams {
  category?: string;
  q?: string;
  cursor?: string;
}

export interface RegistrySearchResult {
  skills: RegistrySkillSummary[];
  nextCursor?: string;
  total?: number;
}

export interface AppwriteRegistryClient {
  fetchSnapshot(): Promise<SharedSkillSnapshot>;
  submit(
    payload: Record<string, unknown>,
    sessionCookie: string,
  ): Promise<void>;
  login(email: string): Promise<string>;
  search(params: RegistrySearchParams): Promise<RegistrySearchResult>;
  detail(id: string): Promise<RegistrySkillDetail>;
  versions(id: string): Promise<RegistrySkillVersion[]>;
  rate(
    sessionCookie: string,
    id: string,
    rating: number,
  ): Promise<RegistrySkillDetail>;
  download(id: string): Promise<RegistrySkillSummary>;
  me(sessionCookie: string): Promise<RegistryUserProfile>;
  updateProfile(
    sessionCookie: string,
    profile: { displayName?: string; bio?: string; avatarUrl?: string },
  ): Promise<RegistryUserProfile>;
}

export interface AppwriteRegistryClientOptions {
  fetchImplementation?: typeof fetch;
  pollIntervalMs?: number;
  loginTimeoutMs?: number;
}

interface DevicePairResponse {
  status: "pending" | "complete";
  userId?: string;
  secret?: string;
}

export class HttpAppwriteRegistryClient implements AppwriteRegistryClient {
  private readonly fetchImplementation: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly loginTimeoutMs: number;

  public constructor(
    private readonly config: SharedSkillsConfig,
    options: AppwriteRegistryClientOptions = {},
  ) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000;
  }

  public async fetchSnapshot(): Promise<SharedSkillSnapshot> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return {
        skills: [],
        revokedSkillIds: [],
      };
    }
    const response = await this.fetchImplementation(
      `${this.config.functionUrl}/skills`,
      { headers: { Accept: "application/json" } },
    );
    const payload = await readJson(response, "Shared skill snapshot");
    const record = asRecord(payload, "Shared skill snapshot");
    const rawSkills = Array.isArray(record.skills) ? record.skills : [];
    const rawRevoked = Array.isArray(record.revokedSkillIds)
      ? record.revokedSkillIds
      : [];
    return {
      skills: rawSkills.map((skill) =>
        parseSnapshotSkill(skill, this.config.registryId),
      ),
      revokedSkillIds: rawRevoked.filter(
        (skillId): skillId is string => typeof skillId === "string",
      ),
      ...(typeof record.cursor === "string" ? { cursor: record.cursor } : {}),
    };
  }

  public async submit(
    payload: Record<string, unknown>,
    sessionCookie: string,
  ): Promise<void> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const uploadsDir = path.resolve(".lhic/shared-skills-uploads");
      await fs.mkdir(uploadsDir, { recursive: true });
      const filename = `${payload.name || "skill"}-${Date.now()}.json`;
      await fs.writeFile(
        path.join(uploadsDir, filename),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
      return;
    }
    const jwt = await this.createJwt(sessionCookie);
    const response = await this.fetchImplementation(
      `${this.config.functionUrl}/skills`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": this.config.projectId,
          "X-Appwrite-User-JWT": jwt,
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Shared skill submission failed with HTTP ${response.status}.`,
      );
    }
  }

  public async login(email: string): Promise<string> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return "mock-session-cookie";
    }
    if (!email.trim()) {
      throw new Error("An email address is required for shared skill login.");
    }
    const deviceCode = randomBytes(32).toString("base64url");
    const callbackUrl = new URL(`${this.config.functionUrl}/auth/callback`);
    callbackUrl.searchParams.set("device", deviceCode);

    const tokenResponse = await this.fetchImplementation(
      `${this.config.endpoint}/account/tokens/magic-url`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": this.config.projectId,
        },
        body: JSON.stringify({
          userId: randomUUID(),
          email: email.trim(),
          url: callbackUrl.toString(),
        }),
      },
    );
    await readJson(tokenResponse, "Magic URL request");

    const deadline = Date.now() + this.loginTimeoutMs;
    while (Date.now() < deadline) {
      await delay(this.pollIntervalMs);
      const pair = await this.pollDeviceCode(deviceCode);
      if (pair.status !== "complete" || !pair.userId || !pair.secret) {
        continue;
      }
      return this.createSession(pair.userId, pair.secret);
    }
    throw new Error("Timed out waiting for Magic URL sign-in.");
  }

  public async search(
    params: RegistrySearchParams,
  ): Promise<RegistrySearchResult> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return mockRegistry.search(params);
    }
    const url = new URL(`${this.config.functionUrl}/skills`);
    if (params.category) url.searchParams.set("category", params.category);
    if (params.q) url.searchParams.set("q", params.q);
    if (params.cursor) url.searchParams.set("cursor", params.cursor);
    const payload = asRecord(
      await readJson(
        await this.fetchImplementation(url, {
          headers: { Accept: "application/json" },
        }),
        "Shared skill search",
      ),
      "Shared skill search",
    );
    const rawSkills = Array.isArray(payload.skills) ? payload.skills : [];
    return {
      skills: rawSkills.map(parseRegistrySkill),
      ...(typeof payload.nextCursor === "string"
        ? { nextCursor: payload.nextCursor }
        : {}),
      ...(typeof payload.total === "number" ? { total: payload.total } : {}),
    };
  }

  public async detail(id: string): Promise<RegistrySkillDetail> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return mockRegistry.detail(id);
    }
    const payload = asRecord(
      await readJson(
        await this.fetchImplementation(
          `${this.config.functionUrl}/skills/${encodeURIComponent(id)}`,
          { headers: { Accept: "application/json" } },
        ),
        "Shared skill detail",
      ),
      "Shared skill detail",
    );
    return parseRegistryDetail(payload);
  }

  public async versions(id: string): Promise<RegistrySkillVersion[]> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return mockRegistry.versions(id);
    }
    const payload = asRecord(
      await readJson(
        await this.fetchImplementation(
          `${this.config.functionUrl}/skills/${encodeURIComponent(id)}/versions`,
          { headers: { Accept: "application/json" } },
        ),
        "Shared skill versions",
      ),
      "Shared skill versions",
    );
    const raw = Array.isArray(payload.versions) ? payload.versions : [];
    return raw.map((entry) => {
      const record = asRecord(entry, "Shared skill version");
      return {
        version: String(record.version ?? ""),
        contentHash: String(record.contentHash ?? ""),
        ...(record.changelog ? { changelog: String(record.changelog) } : {}),
        createdAt: String(record.createdAt ?? ""),
      };
    });
  }

  public async rate(
    sessionCookie: string,
    id: string,
    rating: number,
  ): Promise<RegistrySkillDetail> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return mockRegistry.rate(id, rating);
    }
    const jwt = await this.createJwt(sessionCookie);
    const response = await this.fetchImplementation(
      `${this.config.functionUrl}/skills/${encodeURIComponent(id)}/rate`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": this.config.projectId,
          "X-Appwrite-User-JWT": jwt,
        },
        body: JSON.stringify({ rating }),
      },
    );
    await readJson(response, "Shared skill rating");
    return this.detail(id);
  }

  public async download(id: string): Promise<RegistrySkillSummary> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return mockRegistry.download(id);
    }
    const skill = (await this.detail(id)).skill;
    const payload = asRecord(
      await readJson(
        await this.fetchImplementation(
          `${this.config.functionUrl}/skills/${encodeURIComponent(id)}/download`,
          { method: "POST", headers: { Accept: "application/json" } },
        ),
        "Shared skill download",
      ),
      "Shared skill download",
    );
    return {
      ...skill,
      downloadCount: Number(payload.downloadCount ?? skill.downloadCount),
    };
  }

  public async me(sessionCookie: string): Promise<RegistryUserProfile> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return mockRegistry.me();
    }
    const jwt = await this.createJwt(sessionCookie);
    const payload = asRecord(
      await readJson(
        await this.fetchImplementation(`${this.config.functionUrl}/users/me`, {
          headers: {
            Accept: "application/json",
            "X-Appwrite-Project": this.config.projectId,
            "X-Appwrite-User-JWT": jwt,
          },
        }),
        "Appwrite user profile",
      ),
      "Appwrite user profile",
    );
    return parseRegistryUser(payload.user);
  }

  public async updateProfile(
    sessionCookie: string,
    profile: { displayName?: string; bio?: string; avatarUrl?: string },
  ): Promise<RegistryUserProfile> {
    if (process.env.LHIC_MOCK_APPWRITE === "true") {
      return mockRegistry.updateProfile(profile);
    }
    const jwt = await this.createJwt(sessionCookie);
    const payload = asRecord(
      await readJson(
        await this.fetchImplementation(`${this.config.functionUrl}/users/me`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "X-Appwrite-Project": this.config.projectId,
            "X-Appwrite-User-JWT": jwt,
          },
          body: JSON.stringify(profile),
        }),
        "Appwrite user profile update",
      ),
      "Appwrite user profile update",
    );
    return parseRegistryUser(payload.user);
  }

  private async pollDeviceCode(
    deviceCode: string,
  ): Promise<DevicePairResponse> {
    const url = new URL(`${this.config.functionUrl}/auth/poll`);
    url.searchParams.set("device", deviceCode);
    const response = await this.fetchImplementation(url, {
      headers: { Accept: "application/json" },
    });
    const payload = asRecord(
      await readJson(response, "Magic URL device poll"),
      "Magic URL device poll",
    );
    if (payload.status === "pending") {
      return { status: "pending" };
    }
    if (
      payload.status === "complete" &&
      typeof payload.userId === "string" &&
      typeof payload.secret === "string"
    ) {
      return {
        status: "complete",
        userId: payload.userId,
        secret: payload.secret,
      };
    }
    throw new Error("Magic URL device poll returned an invalid response.");
  }

  private async createSession(userId: string, secret: string): Promise<string> {
    const response = await this.fetchImplementation(
      `${this.config.endpoint}/account/sessions/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Appwrite-Project": this.config.projectId,
        },
        body: JSON.stringify({ userId, secret }),
      },
    );
    await readJson(response, "Appwrite session creation");
    const cookies = getSetCookies(response.headers)
      .map((cookie) => cookie.split(";", 1)[0] ?? "")
      .filter(Boolean);
    if (cookies.length === 0) {
      throw new Error(
        "Appwrite session creation did not return a session cookie.",
      );
    }
    return cookies.join("; ");
  }

  private async createJwt(sessionCookie: string): Promise<string> {
    const response = await this.fetchImplementation(
      `${this.config.endpoint}/account/jwt`,
      {
        method: "POST",
        headers: {
          "X-Appwrite-Project": this.config.projectId,
          Cookie: sessionCookie,
        },
      },
    );
    const payload = asRecord(
      await readJson(response, "Appwrite JWT creation"),
      "Appwrite JWT creation",
    );
    if (typeof payload.jwt !== "string" || !payload.jwt) {
      throw new Error("Appwrite JWT creation returned no JWT.");
    }
    return payload.jwt;
  }
}

function parseSnapshotSkill(value: unknown, registryId: string) {
  const record = asRecord(value, "Shared skill record");
  const required = (key: string): string => {
    const field = record[key];
    if (typeof field !== "string" || !field.trim()) {
      throw new Error(`Shared skill record ${key} must be a non-empty string.`);
    }
    return field;
  };
  if (
    !record.definition ||
    typeof record.definition !== "object" ||
    Array.isArray(record.definition)
  ) {
    throw new Error("Shared skill record definition must be an object.");
  }
  return {
    registryId,
    skillId: required("skillId"),
    version: required("version"),
    name: required("name"),
    operationKey: required("operationKey"),
    fingerprint: required("fingerprint"),
    definition: record.definition as Record<string, unknown>,
    fastPathEligible: record.fastPathEligible === true,
    contentHash: required("contentHash"),
    updatedAt: required("updatedAt"),
  };
}

function parseRegistrySkill(value: unknown): RegistrySkillSummary {
  const record = asRecord(value, "Shared skill record");
  const required = (key: string): string => {
    const field = record[key];
    if (typeof field !== "string" || !field.trim()) {
      throw new Error(`Shared skill record ${key} must be a non-empty string.`);
    }
    return field;
  };
  if (
    !record.definition ||
    typeof record.definition !== "object" ||
    Array.isArray(record.definition)
  ) {
    throw new Error("Shared skill record definition must be an object.");
  }
  return {
    id: required("skillId"),
    version: required("version"),
    name: required("name"),
    operationKey: required("operationKey"),
    fingerprint: required("fingerprint"),
    definition: record.definition as Record<string, unknown>,
    fastPathEligible: record.fastPathEligible === true,
    contentHash: required("contentHash"),
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(typeof record.category === "string" ? { category: record.category } : {}),
    ...(Array.isArray(record.tags)
      ? { tags: record.tags.map(String) }
      : {}),
    downloadCount: Number(record.downloadCount ?? 0),
    ratingAvg: Number(record.ratingAvg ?? 0),
    ratingCount: Number(record.ratingCount ?? 0),
    authorId: String(record.authorId ?? ""),
    ...(typeof record.authorName === "string"
      ? { authorName: record.authorName }
      : {}),
    ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    updatedAt: required("updatedAt"),
  };
}

function parseRegistryDetail(payload: Record<string, unknown>): RegistrySkillDetail {
  if (!payload.skill) {
    throw new Error("Shared skill detail is missing the skill record.");
  }
  const rawVersions = Array.isArray(payload.versions) ? payload.versions : [];
  const rating = asRecord(payload.rating ?? {}, "Shared skill rating summary");
  return {
    skill: parseRegistrySkill(payload.skill),
    versions: rawVersions.map((entry) => {
      const record = asRecord(entry, "Shared skill version");
      return {
        version: String(record.version ?? ""),
        contentHash: String(record.contentHash ?? ""),
        ...(record.changelog ? { changelog: String(record.changelog) } : {}),
        createdAt: String(record.createdAt ?? ""),
      };
    }),
    ...(payload.author
      ? { author: parseRegistryUser(payload.author) }
      : {}),
    rating: {
      avg: Number(rating.avg ?? 0),
      count: Number(rating.count ?? 0),
    },
  };
}

function parseRegistryUser(value: unknown): RegistryUserProfile {
  const record = asRecord(value, "Appwrite user profile");
  return {
    userId: String(record.userId ?? ""),
    displayName: String(record.displayName ?? ""),
    ...(record.bio ? { bio: String(record.bio) } : {}),
    ...(record.avatarUrl ? { avatarUrl: String(record.avatarUrl) } : {}),
  };
}

function mockSkill(
  id: string,
  name: string,
  description: string,
  category: string,
  tags: string[],
  authorName: string,
  ratingAvg: number,
  ratingCount: number,
  downloadCount: number,
): RegistrySkillSummary {
  const createdAt = "2026-07-01T00:00:00.000Z";
  return {
    id,
    version: "1.0.0",
    name,
    operationKey: `operation:${id}`,
    fingerprint: `${id}-fingerprint`,
    definition: {
      compiler: "shared-skill-v1",
      actions: [{ type: "navigate", intent: `run ${name}`, riskLevel: "low" }],
    },
    fastPathEligible: true,
    contentHash: `${id}-content-hash`,
    description,
    category,
    tags,
    downloadCount,
    ratingAvg,
    ratingCount,
    authorId: `author-${id}`,
    authorName,
    createdAt,
    updatedAt: createdAt,
  };
}

class MockRegistry {
  private skills = [
    mockSkill(
      "mock-search",
      "Web search helper",
      "Searches public documentation sites with verifier evidence.",
      "browser",
      ["search", "docs"],
      "Search Bot",
      4.5,
      12,
      340,
    ),
    mockSkill(
      "mock-form-fill",
      "Verified form filling",
      "Fills accessibility-labelled forms with per-step approval.",
      "browser",
      ["forms", "accessibility"],
      "Form Bot",
      4.8,
      9,
      210,
    ),
    mockSkill(
      "mock-desktop-click",
      "Desktop click runner",
      "Executes desktop-plan-v1 OS clicks through the global executor.",
      "desktop",
      ["desktop", "mouse"],
      "Desktop Bot",
      4.2,
      7,
      95,
    ),
    mockSkill(
      "mock-mcp-probe",
      "MCP probe helper",
      "Probes MCP client configurations against local tooling.",
      "mcp",
      ["mcp", "probe"],
      "MCP Bot",
      3.9,
      5,
      64,
    ),
    mockSkill(
      "mock-training",
      "Public-web training",
      "Records verified public-web training candidates locally.",
      "training",
      ["training", "verifier"],
      "Train Bot",
      4.6,
      4,
      41,
    ),
  ];
  private readonly ratings = new Map<string, Map<string, number>>();
  private readonly baseRatings = new Map<string, { avg: number; count: number }>();
  private profile: RegistryUserProfile = {
    userId: "mock-user",
    displayName: "mock-user",
  };

  public constructor() {
    for (const skill of this.skills) {
      this.baseRatings.set(skill.id, {
        avg: skill.ratingAvg,
        count: skill.ratingCount,
      });
    }
  }

  public search(params: RegistrySearchParams): RegistrySearchResult {
    const needle = params.q?.toLocaleLowerCase();
    const filtered = this.skills.filter((skill) => {
      if (params.category && skill.category !== params.category) return false;
      if (needle) {
        const haystack = `${skill.name} ${skill.description ?? ""}`.toLocaleLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
    const start = params.cursor
      ? filtered.findIndex((skill) => skill.id === params.cursor) + 1
      : 0;
    const page = filtered.slice(start, start + 50);
    const result: RegistrySearchResult = {
      skills: page.map((skill) => ({ ...skill })),
      total: filtered.length,
    };
    const last = page.at(-1);
    if (start + 50 < filtered.length && last) {
      result.nextCursor = last.id;
    }
    return result;
  }

  public detail(id: string): RegistrySkillDetail {
    const skill = this.require(id);
    return {
      skill: { ...skill },
      versions: [
        {
          version: skill.version,
          contentHash: skill.contentHash,
          changelog: "Initial submission",
          createdAt: skill.createdAt ?? "2026-07-01T00:00:00.000Z",
        },
      ],
      author: { userId: skill.authorId, displayName: skill.authorName ?? "Author" },
      rating: this.ratingFor(id),
    };
  }

  public versions(id: string): RegistrySkillVersion[] {
    const skill = this.require(id);
    return [
      {
        version: skill.version,
        contentHash: skill.contentHash,
        changelog: "Initial submission",
        createdAt: skill.createdAt ?? "2026-07-01T00:00:00.000Z",
      },
    ];
  }

  public rate(id: string, rating: number): RegistrySkillDetail {
    const skill = this.require(id);
    const byUser = this.ratings.get(id) ?? new Map<string, number>();
    byUser.set("mock-user", rating);
    this.ratings.set(id, byUser);
    const summary = this.ratingFor(id);
    const index = this.skills.findIndex((candidate) => candidate.id === id);
    this.skills[index] = {
      ...skill,
      ratingAvg: summary.avg,
      ratingCount: summary.count,
    };
    return this.detail(id);
  }

  public download(id: string): RegistrySkillSummary {
    const skill = this.require(id);
    const index = this.skills.findIndex((candidate) => candidate.id === id);
    this.skills[index] = { ...skill, downloadCount: skill.downloadCount + 1 };
    return { ...this.skills[index] };
  }

  public me(): RegistryUserProfile {
    return { ...this.profile };
  }

  public updateProfile(profile: {
    displayName?: string;
    bio?: string;
    avatarUrl?: string;
  }): RegistryUserProfile {
    this.profile = {
      ...this.profile,
      ...(profile.displayName !== undefined
        ? { displayName: profile.displayName }
        : {}),
      ...(profile.bio !== undefined ? { bio: profile.bio } : {}),
      ...(profile.avatarUrl !== undefined
        ? { avatarUrl: profile.avatarUrl }
        : {}),
    };
    return { ...this.profile };
  }

  private require(id: string): RegistrySkillSummary {
    const skill = this.skills.find((candidate) => candidate.id === id);
    if (!skill) {
      throw new Error(`Skill not found: ${id}`);
    }
    return skill;
  }

  private ratingFor(id: string): { avg: number; count: number } {
    const base = this.baseRatings.get(id) ?? { avg: 0, count: 0 };
    const byUser = this.ratings.get(id);
    if (!byUser || byUser.size === 0) {
      return { avg: base.avg, count: base.count };
    }
    const userRatings = [...byUser.values()];
    const count = base.count + userRatings.length;
    const total =
      base.avg * base.count +
      userRatings.reduce((sum, value) => sum + value, 0);
    const avg = count ? Math.round((total / count) * 10) / 10 : 0;
    return { avg, count };
  }
}

const mockRegistry = new MockRegistry();

async function readJson(response: Response, name: string): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`${name} failed with HTTP ${response.status}.`);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new Error(`${name} returned invalid JSON.`);
  }
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function getSetCookies(headers: Headers): string[] {
  const nodeHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (nodeHeaders.getSetCookie) {
    return nodeHeaders.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
