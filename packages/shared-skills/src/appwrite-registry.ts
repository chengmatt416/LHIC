import { randomBytes, randomUUID } from "node:crypto";

import type { SharedSkillSnapshot } from "@lhic/memory";

import type { SharedSkillsConfig } from "./config.js";

export interface AppwriteRegistryClient {
  fetchSnapshot(): Promise<SharedSkillSnapshot>;
  submit(
    payload: Record<string, unknown>,
    sessionCookie: string,
  ): Promise<void>;
  login(email: string): Promise<string>;
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
