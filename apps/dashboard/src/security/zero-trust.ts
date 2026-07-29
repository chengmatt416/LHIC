/**
 * Zero-Trust Cryptographic & Security Module for LHIC Dashboard
 */

export async function sha256Hash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encryptSecret(
  secret: string,
  passKey: string
): Promise<{ ciphertext: string; iv: string }> {
  const encoder = new TextEncoder();
  const passKeyData = encoder.encode(passKey.padStart(32, "0").slice(0, 32));

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    passKeyData,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encoder.encode(secret)
  );

  return {
    ciphertext: Array.from(new Uint8Array(encryptedBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    iv: Array.from(iv)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  };
}

export function sanitizeInput(input: string, maxLength = 256): string {
  if (typeof input !== "string") return "";
  return input
    .slice(0, maxLength)
    .replace(/[<>'"&]/g, "")
    .trim();
}
