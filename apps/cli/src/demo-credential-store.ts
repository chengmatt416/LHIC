import { createHash } from "node:crypto";

import { Entry } from "@napi-rs/keyring";

import type { DemoModelProviderKind } from "@lhic/controller";

const serviceName = "lhic-demo-model-api-key";

export interface DemoCredentialStore {
  get(
    provider: DemoModelProviderKind,
    endpoint?: string,
  ): Promise<string | undefined>;
  set(
    provider: DemoModelProviderKind,
    apiKey: string,
    endpoint?: string,
  ): Promise<void>;
}

export class KeyringDemoCredentialStore implements DemoCredentialStore {
  public async get(
    provider: DemoModelProviderKind,
    endpoint?: string,
  ): Promise<string | undefined> {
    try {
      return (
        (await Promise.resolve(this.entry(provider, endpoint).getPassword())) ??
        undefined
      );
    } catch {
      return undefined;
    }
  }

  public async set(
    provider: DemoModelProviderKind,
    apiKey: string,
    endpoint?: string,
  ): Promise<void> {
    if (!apiKey.trim()) {
      throw new Error("The API key must not be empty.");
    }
    await Promise.resolve(
      this.entry(provider, endpoint).setPassword(apiKey.trim()),
    );
  }

  private entry(provider: DemoModelProviderKind, endpoint?: string): Entry {
    return new Entry(serviceName, credentialAccount(provider, endpoint));
  }
}

function credentialAccount(
  provider: DemoModelProviderKind,
  endpoint?: string,
): string {
  if (!endpoint) return provider;
  const endpointHash = createHash("sha256")
    .update(endpoint)
    .digest("hex")
    .slice(0, 24);
  return `${provider}:endpoint:${endpointHash}`;
}
