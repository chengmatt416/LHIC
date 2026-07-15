import { verify, type KeyLike } from "node:crypto";

export interface KmsConfig {
  provider: "aws" | "gcp" | "vault" | "local";
  region?: string;
  endpoint?: string;
  keyId?: string;
}

export class KmsKeyManager {
  private readonly cachedKeys: Map<string, string | KeyLike> = new Map();

  public constructor(private readonly config: KmsConfig) {}

  /**
   * Fetches public key from AWS/GCP KMS or HashiCorp Vault.
   */
  public async fetchPublicKey(keyId: string): Promise<string | KeyLike> {
    const cacheKey = `${this.config.provider}:${keyId}`;
    if (this.cachedKeys.has(cacheKey)) {
      return this.cachedKeys.get(cacheKey)!;
    }

    if (this.config.provider === "local") {
      const localKey =
        process.env[
          `LHIC_KMS_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`
        ] || process.env.LHIC_KMS_DEFAULT_PUBLIC_KEY;
      if (!localKey) {
        throw new Error(`Local KMS Key ID ${keyId} not found in environment.`);
      }
      this.cachedKeys.set(cacheKey, localKey);
      return localKey;
    }

    // Enterprise AWS KMS / GCP KMS / Vault provider simulation
    if (this.config.provider === "aws") {
      // Mock fetch from AWS KMS region endpoint
      const key = `-----BEGIN PUBLIC KEY-----\nMCOWBQBDMOCKAWSKMSKEY\n-----END PUBLIC KEY-----`;
      this.cachedKeys.set(cacheKey, key);
      return key;
    }

    if (this.config.provider === "gcp") {
      // Mock fetch from GCP Cloud KMS API
      const key = `-----BEGIN PUBLIC KEY-----\nMCOWBQBDMOCKGCPKMSKEY\n-----END PUBLIC KEY-----`;
      this.cachedKeys.set(cacheKey, key);
      return key;
    }

    if (this.config.provider === "vault") {
      // Mock fetch from HashiCorp Vault transit secrets engine
      const key = `-----BEGIN PUBLIC KEY-----\nMCOWBQBDMOCKVAULTKEY\n-----END PUBLIC KEY-----`;
      this.cachedKeys.set(cacheKey, key);
      return key;
    }

    throw new Error(`Unsupported KMS provider: ${this.config.provider}`);
  }

  /**
   * Verifies signature of approval using fetched KMS key.
   */
  public async verifyKmsSignature(
    payload: string,
    signatureBase64: string,
    keyId: string,
  ): Promise<boolean> {
    try {
      const publicKey = await this.fetchPublicKey(keyId);
      return verify(
        null,
        Buffer.from(payload),
        publicKey,
        Buffer.from(signatureBase64, "base64"),
      );
    } catch {
      return false;
    }
  }
}
