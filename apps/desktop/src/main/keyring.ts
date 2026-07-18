import { createHash } from "node:crypto";

import { Entry } from "@napi-rs/keyring";

const serviceName = "lhic-control-center";

/** Stores provider credentials in the operating-system keychain, never in app state. */
export class DesktopCredentialStore {
  public async set(id: string, secret: string): Promise<void> {
    if (!id.trim() || !secret.trim()) {
      throw new Error("Credential id and value are required.");
    }
    await Promise.resolve(this.entry(id).setPassword(secret));
  }

  public async has(id: string): Promise<boolean> {
    return Boolean(await this.get(id));
  }

  public async get(id: string): Promise<string | undefined> {
    try {
      return (await Promise.resolve(this.entry(id).getPassword())) ?? undefined;
    } catch {
      return undefined;
    }
  }

  public async remove(id: string): Promise<void> {
    try {
      await Promise.resolve(this.entry(id).deletePassword());
    } catch {
      // A missing keychain item is already the intended state.
    }
  }

  private entry(id: string): Entry {
    return new Entry(
      serviceName,
      createHash("sha256").update(id).digest("hex"),
    );
  }
}
