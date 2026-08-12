import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HttpAppwriteRegistryClient,
  type SharedSkillCredentialStore,
} from "@lhic/shared-skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountService } from "./account-service.js";
import { LibraryService } from "./library-service.js";
import { SkillsService } from "./skills-service.js";

class MemoryCredentialStore implements SharedSkillCredentialStore {
  private readonly values = new Map<string, string>();

  public async get(config: { registryId: string }): Promise<string | undefined> {
    return this.values.get(config.registryId);
  }

  public async set(
    config: { registryId: string },
    sessionCookie: string,
  ): Promise<void> {
    this.values.set(config.registryId, sessionCookie);
  }

  public async delete(config: { registryId: string }): Promise<void> {
    this.values.delete(config.registryId);
  }
}

describe("Account + Library services (mock Appwrite)", () => {
  let directory: string;
  let skills: SkillsService;
  let credentials: MemoryCredentialStore;

  beforeEach(async () => {
    process.env.LHIC_MOCK_APPWRITE = "true";
    directory = await mkdtemp(join(tmpdir(), "lhic-desktop-account-"));
    credentials = new MemoryCredentialStore();
    skills = new SkillsService(directory, {
      databaseFile: ".lhic/test.sqlite",
      credentialStore: credentials,
    });
  });

  afterEach(async () => {
    delete process.env.LHIC_MOCK_APPWRITE;
    await rm(directory, { recursive: true, force: true });
  });

  it("signs in, persists the account, patches the profile, and signs out", async () => {
    const account = new AccountService(
      directory,
      skills,
      new HttpAppwriteRegistryClient({
        endpoint: "https://appwrite.test/v1",
        projectId: "project",
        functionUrl: "https://registry.test",
      }),
      credentials,
    );

    expect(await account.status()).toEqual({ mode: "offline" });

    const signedIn = await account.login("alice@example.com");
    expect(signedIn.mode).toBe("signed-in");
    expect(signedIn.email).toBe("alice@example.com");
    expect(signedIn.profile?.displayName).toBe("mock-user");
    expect(await account.status()).toMatchObject({
      mode: "signed-in",
      userId: "mock-user",
    });

    const updated = await account.updateProfile({
      displayName: "Alice",
      bio: "Skill builder",
    });
    expect(updated.profile?.displayName).toBe("Alice");
    expect(updated.profile?.bio).toBe("Skill builder");

    const signedOut = await account.logout();
    expect(signedOut).toEqual({ mode: "offline" });
    expect(await account.status()).toEqual({ mode: "offline" });
  });

  it("requires sign-in before profile updates", async () => {
    const account = new AccountService(
      directory,
      skills,
      new HttpAppwriteRegistryClient({
        endpoint: "https://appwrite.test/v1",
        projectId: "project",
        functionUrl: "https://registry.test",
      }),
      credentials,
    );
    await expect(account.updateProfile({ displayName: "Alice" })).rejects.toThrow(
      "Sign in first.",
    );
  });

  it("searches, rates, and downloads skills into the local mirror", async () => {
    const registry = new HttpAppwriteRegistryClient({
      endpoint: "https://appwrite.test/v1",
      projectId: "project",
      functionUrl: "https://registry.test",
    });
    const account = new AccountService(
      directory,
      skills,
      registry,
      credentials,
    );
    const library = new LibraryService({
      skills,
      registry,
      credentialStore: credentials,
      isSignedIn: async () => (await account.status()).mode === "signed-in",
    });

    await expect(
      library.search({ category: "browser" }),
    ).rejects.toThrow("Sign in to browse the shared library.");

    await account.login("alice@example.com");

    const browser = await library.search({ category: "browser" });
    expect(browser.skills.length).toBeGreaterThan(0);
    expect(browser.skills[0]?.category).toBe("browser");
    expect(browser.total).toBeGreaterThanOrEqual(1);

    const query = await library.search({ q: "form" });
    expect(query.skills.map((skill) => skill.name)).toContain(
      "Verified form filling",
    );

    const detail = await library.detail("mock-search");
    expect(detail.skill.name).toBe("Web search helper");
    expect(detail.versions.length).toBeGreaterThan(0);
    expect(detail.rating.count).toBe(12);

    const rated = await library.rate("mock-search", 5);
    expect(rated.rating.count).toBe(13);
    expect(rated.skill.ratingAvg).toBeGreaterThan(0);

    const downloaded = await library.download("mock-search");
    expect(downloaded.downloadCount).toBe(341);

    const listed = await skills.list();
    expect(listed.some((skill) => skill.name === "Web search helper")).toBe(
      true,
    );
  });
});
