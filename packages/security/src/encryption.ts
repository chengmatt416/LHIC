import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";

/**
 * Encrypts cleartext using AES-256-GCM with a secret key.
 */
export function encryptText(text: string, secret: string): string {
  const key = deriveKey(secret);

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");

  return `v1:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/**
 * Decrypts ciphertext using AES-256-GCM.
 */
export function decryptText(cipherText: string, secret: string): string {
  const key = deriveKey(secret);
  const [version, ivHex, authTagHex, encryptedHex] = cipherText.split(":");
  if (version !== "v1") {
    throw new Error("Encrypted text has an unsupported format.");
  }
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Encrypted text is malformed.");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function deriveKey(secret: string): Buffer {
  if (!secret.trim()) {
    throw new Error("Encryption requires a non-empty secret.");
  }
  return scryptSync(secret, "lhic-encryption-v1", 32);
}
