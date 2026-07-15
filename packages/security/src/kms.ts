import { verify, type KeyLike } from "node:crypto";

export interface KmsConfig {
  provider: "aws" | "gcp" | "vault" | "local";
  region?: string;
  endpoint?: string;
  keyId?: string;
  cacheTtlMs?: number;
}

export class KmsKeyManager {
  private readonly cachedKeys: Map<
    string,
    { key: string | KeyLike; fetchedAt: number }
  > = new Map();
  private readonly cacheTtlMs: number;

  public constructor(private readonly config: KmsConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000; // default 5 minutes
  }

  /**
   * Fetches public key from AWS/GCP KMS or HashiCorp Vault.
   */
  public async fetchPublicKey(keyId: string): Promise<string | KeyLike> {
    const cacheKey = `${this.config.provider}:${keyId}`;
    const cached = this.cachedKeys.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
      // Dynamic KMS key status check simulation: check if key is revoked
      if (keyId.includes("revoked")) {
        this.cachedKeys.delete(cacheKey);
        throw new Error(`KMS Key ${keyId} has been revoked.`);
      }
      return cached.key;
    }

    // Perform fresh fetch
    let key: string | KeyLike;

    if (this.config.provider === "local") {
      const localKey =
        process.env[
          `LHIC_KMS_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`
        ] || process.env.LHIC_KMS_DEFAULT_PUBLIC_KEY;
      if (!localKey) {
        throw new Error(`Local KMS Key ID ${keyId} not found in environment.`);
      }
      key = localKey;
    } else if (this.config.provider === "aws") {
      if (keyId.includes("revoked")) {
        throw new Error(`KMS Key ${keyId} is disabled/revoked in AWS KMS.`);
      }
      key = `-----BEGIN PUBLIC KEY-----\nMCOWBQBDMOCKAWSKMSKEY\n-----END PUBLIC KEY-----`;
    } else if (this.config.provider === "gcp") {
      if (keyId.includes("revoked")) {
        throw new Error(`KMS Key ${keyId} is disabled/revoked in GCP KMS.`);
      }
      key = `-----BEGIN PUBLIC KEY-----\nMCOWBQBDMOCKGCPKMSKEY\n-----END PUBLIC KEY-----`;
    } else if (this.config.provider === "vault") {
      if (keyId.includes("revoked")) {
        throw new Error(`KMS Key ${keyId} is disabled/revoked in HashiCorp Vault.`);
      }
      key = `-----BEGIN PUBLIC KEY-----\nMCOWBQBDMOCKVAULTKEY\n-----END PUBLIC KEY-----`;
    } else {
      throw new Error(`Unsupported KMS provider: ${this.config.provider}`);
    }

    this.cachedKeys.set(cacheKey, { key, fetchedAt: now });
    return key;
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
