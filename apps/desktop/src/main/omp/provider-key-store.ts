import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { safeStorage } from "electron";

import type { OmpProviderKeyStatus } from "../../shared/contracts.js";
import type { DesktopCredentialStore } from "../keyring.js";

/**
 * Provider API keys for the omp agent engine, mapped to the environment
 * variable names omp reads at startup. Keys prefer the OS keychain; when the
 * keychain is unavailable (e.g. a Linux session without a Secret Service,
 * like a Termux PRoot), they fall back to a 0600 file encrypted with
 * Electron's safeStorage when possible.
 */
export const OMP_PROVIDER_ENV: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  together: "TOGETHER_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

interface ProviderKeyFile {
  schemaVersion: "lhic-provider-keys-v1";
  /** Provider id -> base64 ciphertext (safeStorage) or plaintext. */
  keys: Record<string, string>;
  encrypted: boolean;
}

export class OmpProviderKeyStore {
  private readonly filePath: string;

  public constructor(
    private readonly keychain: DesktopCredentialStore | undefined,
    userDataDir: string,
  ) {
    this.filePath = join(userDataDir, "omp", "provider-keys.json");
  }

  public static envVarFor(provider: string): string | undefined {
    return OMP_PROVIDER_ENV[provider];
  }

  public async hasKey(provider: string): Promise<boolean> {
    return Boolean(await this.getKey(provider));
  }

  public async getKey(provider: string): Promise<string | undefined> {
    const keychainValue = await this.keychain?.get(this.keychainId(provider));
    if (keychainValue) return keychainValue;
    return this.readFileKey(provider);
  }

  public async setKey(provider: string, key: string): Promise<void> {
    if (!provider.trim() || !key.trim()) {
      throw new Error("Provider id and API key are required.");
    }
    try {
      await this.keychain?.set(this.keychainId(provider), key);
      if (this.keychain) {
        await this.removeFileKey(provider);
        return;
      }
    } catch {
      // Keychain unavailable — persist in the fallback file.
    }
    await this.writeFileKey(provider, key);
  }

  public async removeKey(provider: string): Promise<void> {
    await this.keychain?.remove(this.keychainId(provider));
    await this.removeFileKey(provider);
  }

  public async status(): Promise<OmpProviderKeyStatus[]> {
    const keychainKeys = new Set(
      (
        await Promise.all(
          Object.keys(OMP_PROVIDER_ENV).map(async (provider) => {
            const key = await this.keychain?.get(this.keychainId(provider));
            return key ? provider : undefined;
          }),
        )
      ).filter((provider): provider is string => Boolean(provider)),
    );
    const fileKeys = new Set(Object.keys((await this.readFile()).keys));
    return Object.entries(OMP_PROVIDER_ENV).map(([provider, envVar]) => {
      const inKeychain = keychainKeys.has(provider);
      const inFile = fileKeys.has(provider);
      return {
        provider,
        envVar,
        hasKey: inKeychain || inFile,
        storage: inKeychain ? "keychain" : inFile ? "file" : "none",
      };
    });
  }

  public async buildOmpEnv(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    await Promise.all(
      Object.entries(OMP_PROVIDER_ENV).map(async ([provider, envVar]) => {
        const key = await this.getKey(provider);
        if (key) env[envVar] = key;
      }),
    );
    return env;
  }

  private keychainId(provider: string): string {
    return `omp-provider:${provider}`;
  }

  private async readFileKey(provider: string): Promise<string | undefined> {
    const file = await this.readFile();
    const stored = file.keys[provider];
    if (!stored) return undefined;
    if (file.encrypted) {
      try {
        return safeStorage.decryptString(Buffer.from(stored, "base64"));
      } catch {
        return undefined;
      }
    }
    return stored;
  }

  private async writeFileKey(provider: string, key: string): Promise<void> {
    const file = await this.readFile();
    const encrypted = safeStorage.isEncryptionAvailable();
    file.keys[provider] = encrypted
      ? safeStorage.encryptString(key).toString("base64")
      : key;
    file.encrypted = encrypted;
    await this.writeFile(file);
  }

  private async removeFileKey(provider: string): Promise<void> {
    const file = await this.readFile();
    if (!(provider in file.keys)) return;
    delete file.keys[provider];
    await this.writeFile(file);
  }

  private async readFile(): Promise<ProviderKeyFile> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<ProviderKeyFile>;
      if (
        parsed.schemaVersion === "lhic-provider-keys-v1" &&
        parsed.keys &&
        typeof parsed.keys === "object" &&
        !Array.isArray(parsed.keys)
      ) {
        return {
          schemaVersion: "lhic-provider-keys-v1",
          keys: parsed.keys,
          encrypted: parsed.encrypted === true,
        };
      }
    } catch {
      // Missing or malformed file — start empty.
    }
    return {
      schemaVersion: "lhic-provider-keys-v1",
      keys: {},
      encrypted: false,
    };
  }

  private async writeFile(file: ProviderKeyFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}

/** Removes the fallback file (used by tests and when wiping app data). */
export async function removeProviderKeyFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
