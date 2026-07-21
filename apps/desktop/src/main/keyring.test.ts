import { describe, expect, it, vi } from "vitest";

import { DesktopCredentialStore } from "./keyring.js";

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

describe("DesktopCredentialStore", () => {
  it("throws error when id or secret is empty", async () => {
    const credentials = new DesktopCredentialStore();
    await expect(credentials.set("", "secret")).rejects.toThrow(
      "Credential id and value are required.",
    );
    await expect(credentials.set("id", "  ")).rejects.toThrow(
      "Credential id and value are required.",
    );
  });

  it("stores, retrieves, checks presence, and removes credentials", async () => {
    const credentials = new DesktopCredentialStore();
    const id = "openai-responses";
    const secret = "sk-test123456789";

    expect(await credentials.has(id)).toBe(false);
    expect(await credentials.get(id)).toBeUndefined();

    await credentials.set(id, secret);
    expect(await credentials.has(id)).toBe(true);
    expect(await credentials.get(id)).toBe(secret);

    await credentials.remove(id);
    expect(await credentials.has(id)).toBe(false);
    expect(await credentials.get(id)).toBeUndefined();
  });
});
