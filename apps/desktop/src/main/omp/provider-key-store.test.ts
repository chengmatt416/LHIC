import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopCredentialStore } from "../keyring.js";
import { OmpProviderKeyStore, OMP_PROVIDER_ENV } from "./provider-key-store.js";

vi.mock("@napi-rs/keyring", () => {
  const store = new Map<string, string>();
  return {
    Entry: vi.fn().mockImplementation((_service: string, account: string) => ({
      setPassword: vi.fn().mockImplementation((password: string) => {
        store.set(account, password);
      }),
      getPassword: vi.fn().mockImplementation(() => {
        return store.get(account) ?? null;
      }),
      deletePassword: vi.fn().mockImplementation(() => {
        store.delete(account);
      }),
    })),
  };
});

const encryptionAvailable = { value: true };

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => encryptionAvailable.value),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
    decryptString: vi.fn((data: Buffer) => String(data).replace(/^enc:/, "")),
  },
}));

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lhic-provider-keys-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("OmpProviderKeyStore", () => {
  it("maps known providers to omp environment variables", () => {
    expect(OMP_PROVIDER_ENV.openai).toBe("OPENAI_API_KEY");
    expect(OMP_PROVIDER_ENV.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(OmpProviderKeyStore.envVarFor("gemini")).toBe("GEMINI_API_KEY");
    expect(OmpProviderKeyStore.envVarFor("unknown")).toBeUndefined();
  });

  it("stores keys in the keychain when available and builds the omp env", async () => {
    const directory = await temporaryDirectory();
    const store = new OmpProviderKeyStore(
      new DesktopCredentialStore(),
      directory,
    );

    expect(await store.hasKey("openai")).toBe(false);
    await store.setKey("openai", "sk-openai-test");
    expect(await store.hasKey("openai")).toBe(true);
    expect(await store.getKey("openai")).toBe("sk-openai-test");
    await store.setKey("anthropic", "sk-anthropic-test");

    const env = await store.buildOmpEnv();
    expect(env).toEqual({
      OPENAI_API_KEY: "sk-openai-test",
      ANTHROPIC_API_KEY: "sk-anthropic-test",
    });
    expect(env.GEMINI_API_KEY).toBeUndefined();

    const status = await store.status();
    expect(status.find((entry) => entry.provider === "openai")).toMatchObject({
      provider: "openai",
      envVar: "OPENAI_API_KEY",
      hasKey: true,
      storage: "keychain",
    });

    await store.removeKey("openai");
    expect(await store.hasKey("openai")).toBe(false);
  });

  it("falls back to an encrypted file when the keychain is unavailable", async () => {
    const directory = await temporaryDirectory();
    const failingKeychain = {
      set: vi.fn().mockRejectedValue(new Error("no secret service")),
      get: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopCredentialStore;
    const store = new OmpProviderKeyStore(failingKeychain, directory);

    await store.setKey("openai", "sk-file-test");
    expect(await store.getKey("openai")).toBe("sk-file-test");

    const status = await store.status();
    expect(status.find((entry) => entry.provider === "openai")).toMatchObject({
      hasKey: true,
      storage: "file",
    });

    const persisted = JSON.parse(
      await readFile(join(directory, "omp", "provider-keys.json"), "utf8"),
    ) as {
      schemaVersion: string;
      encrypted: boolean;
      keys: Record<string, string>;
    };
    expect(persisted.schemaVersion).toBe("lhic-provider-keys-v1");
    expect(persisted.encrypted).toBe(true);
    expect(persisted.keys.openai).toBe(
      Buffer.from("enc:sk-file-test").toString("base64"),
    );

    await store.removeKey("openai");
    expect(await store.hasKey("openai")).toBe(false);
  });

  it("stores plaintext with a clear schema when safeStorage encryption is unavailable", async () => {
    const directory = await temporaryDirectory();
    const failingKeychain = {
      set: vi.fn().mockRejectedValue(new Error("no secret service")),
      get: vi.fn().mockResolvedValue(undefined),
      has: vi.fn().mockResolvedValue(false),
      remove: vi.fn().mockResolvedValue(undefined),
    } as unknown as DesktopCredentialStore;
    encryptionAvailable.value = false;
    try {
      const store = new OmpProviderKeyStore(failingKeychain, directory);
      await store.setKey("groq", "gsk-file-test");
      const persisted = JSON.parse(
        await readFile(join(directory, "omp", "provider-keys.json"), "utf8"),
      ) as { encrypted: boolean; keys: Record<string, string> };
      expect(persisted.encrypted).toBe(false);
      expect(persisted.keys.groq).toBe("gsk-file-test");
    } finally {
      encryptionAvailable.value = true;
    }
  });
});
