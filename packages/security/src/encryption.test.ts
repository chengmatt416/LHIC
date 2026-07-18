import { describe, expect, it } from "vitest";
import { decryptText, encryptText } from "./encryption.js";

describe("AES-256-GCM Encryption", () => {
  it("encrypts and decrypts text correctly using a secret key", () => {
    const secret = "my-super-secret-key-that-is-long";
    const plainText = "Hello, this is a secret payload!";

    const encrypted = encryptText(plainText, secret);
    expect(encrypted).not.toBe(plainText);
    expect(encrypted).toContain(":");

    const decrypted = decryptText(encrypted, secret);
    expect(decrypted).toBe(plainText);
  });

  it("fails closed when encryption material or ciphertext is invalid", () => {
    expect(() => encryptText("Public data", "")).toThrow("non-empty secret");
    expect(() => decryptText("Public data", "valid-secret")).toThrow(
      "unsupported format",
    );
  });
});
