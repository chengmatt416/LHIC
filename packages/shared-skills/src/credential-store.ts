import { Entry } from "@napi-rs/keyring";

import type { SharedSkillsConfig } from "./config.js";

const serviceName = "lhic-shared-skills";

export interface SharedSkillCredentialStore {
  get(config: SharedSkillsConfig): Promise<string | undefined>;
  set(config: SharedSkillsConfig, sessionCookie: string): Promise<void>;
  delete(config: SharedSkillsConfig): Promise<void>;
}

export class KeyringSharedSkillCredentialStore implements SharedSkillCredentialStore {
  public async get(config: SharedSkillsConfig): Promise<string | undefined> {
    try {
      return (
        (await Promise.resolve(this.entry(config).getPassword())) ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  public async set(
    config: SharedSkillsConfig,
    sessionCookie: string,
  ): Promise<void> {
    if (!sessionCookie.trim()) {
      throw new Error("Appwrite session cookie must not be empty.");
    }
    await Promise.resolve(this.entry(config).setPassword(sessionCookie));
  }

  public async delete(config: SharedSkillsConfig): Promise<void> {
    try {
      await Promise.resolve(this.entry(config).deletePassword());
    } catch {
      // Deleting a missing credential is already the desired state.
    }
  }

  private entry(config: SharedSkillsConfig): Entry {
    return new Entry(serviceName, config.registryId);
  }
}
