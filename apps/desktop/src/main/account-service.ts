import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  AppwriteRegistryClient,
  SharedSkillCredentialStore,
} from "@lhic/shared-skills";

import type { AccountStatus, UserProfile } from "../shared/contracts.js";
import type { SkillsService } from "./skills-service.js";

const accountFileName = ".lhic/account.json";

/**
 * Optional account session on top of the Magic URL shared-skill login. The
 * Appwrite session cookie stays in the OS Keychain; this file records only
 * the offline/signed-in mode and the public profile mirror, so the app works
 * fully offline by default.
 */
export class AccountService {
  private readonly path: string;

  public constructor(
    private readonly workspaceRoot: string,
    private readonly skills: SkillsService,
    private readonly registry: AppwriteRegistryClient,
    private readonly credentialStore: SharedSkillCredentialStore,
  ) {
    this.path = resolve(workspaceRoot, accountFileName);
  }

  public async status(): Promise<AccountStatus> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      return validateAccountStatus(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { mode: "offline" };
      }
      throw error;
    }
  }

  public async login(email: string): Promise<AccountStatus> {
    await this.skills.login(email);
    const config = await this.skills.sharedSkillsConfig();
    const sessionCookie = config
      ? await this.credentialStore.get(config)
      : undefined;
    if (!sessionCookie) {
      throw new Error(
        "The Magic Link session did not reach the OS Keychain; try signing in again.",
      );
    }
    let profile = await this.registry.me(sessionCookie);
    if (!profile.displayName.trim()) {
      profile = await this.registry.updateProfile(sessionCookie, {
        displayName: email.split("@")[0] ?? email,
      });
    }
    const status: AccountStatus = {
      mode: "signed-in",
      email,
      userId: profile.userId,
      profile,
    };
    await this.writeStatus(status);
    return status;
  }

  public async logout(): Promise<AccountStatus> {
    await this.skills.logout();
    await rm(this.path, { force: true });
    return { mode: "offline" };
  }

  public async updateProfile(
    profile: Partial<Omit<UserProfile, "userId">>,
  ): Promise<AccountStatus> {
    const current = await this.status();
    if (current.mode !== "signed-in" || !current.userId) {
      throw new Error("Sign in first.");
    }
    const config = await this.skills.sharedSkillsConfig();
    const sessionCookie = config
      ? await this.credentialStore.get(config)
      : undefined;
    if (!sessionCookie) {
      throw new Error(
        "The Appwrite session cookie is missing; sign in again to update your profile.",
      );
    }
    const updated = await this.registry.updateProfile(sessionCookie, {
      ...(profile.displayName !== undefined
        ? { displayName: profile.displayName }
        : {}),
      ...(profile.bio !== undefined ? { bio: profile.bio } : {}),
      ...(profile.avatarUrl !== undefined
        ? { avatarUrl: profile.avatarUrl }
        : {}),
    });
    const status: AccountStatus = {
      ...current,
      userId: updated.userId,
      profile: updated,
    };
    await this.writeStatus(status);
    return status;
  }

  private async writeStatus(status: AccountStatus): Promise<void> {
    const content = `${JSON.stringify(status, null, 2)}\n`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}

function validateAccountStatus(value: unknown): AccountStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Account state is invalid.");
  }
  const record = value as Partial<AccountStatus>;
  if (record.mode === "offline") {
    return { mode: "offline" };
  }
  if (record.mode === "signed-in") {
    const profile = record.profile;
    if (
      typeof record.userId !== "string" ||
      !profile ||
      typeof profile !== "object"
    ) {
      throw new Error("Account state is invalid.");
    }
    const user = profile as UserProfile;
    return {
      mode: "signed-in",
      ...(typeof record.email === "string" ? { email: record.email } : {}),
      userId: record.userId,
      profile: {
        userId: user.userId,
        displayName: user.displayName,
        ...(user.bio ? { bio: user.bio } : {}),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
      },
    };
  }
  throw new Error("Account state is invalid.");
}
