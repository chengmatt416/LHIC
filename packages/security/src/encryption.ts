import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypts cleartext using AES-256-GCM with a secret key.
 */
export function encryptText(text: string, secret: string): string {
  if (!secret) {
    return text;
  }
  const key = Buffer.alloc(32);
  Buffer.from(secret, "utf8").copy(key);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts ciphertext using AES-256-GCM.
 */
export function decryptText(cipherText: string, secret: string): string {
  if (!secret || !cipherText.includes(":")) {
    return cipherText;
  }

  const key = Buffer.alloc(32);
  Buffer.from(secret, "utf8").copy(key);

  const [ivHex, authTagHex, encryptedHex] = cipherText.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) {
    return cipherText;
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
