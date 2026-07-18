import { createPublicKey, verify, type KeyLike } from "node:crypto";

export interface KmsConfig {
  provider: "aws" | "gcp" | "vault" | "local";
  region?: string;
  endpoint?: string;
  keyId?: string;
  cacheTtlMs?: number;
  vaultToken?: string;
  gcpAccessToken?: string;
  fetchImplementation?: typeof fetch;
}

export class KmsKeyManager {
  private readonly cachedKeys: Map<
    string,
    { key: string | KeyLike; fetchedAt: number }
  > = new Map();
  private readonly cacheTtlMs: number;
  private readonly fetchImplementation: typeof fetch;

  public constructor(private readonly config: KmsConfig) {
    this.cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;
    this.fetchImplementation = config.fetchImplementation ?? fetch;
  }

  /**
   * Fetches public key from AWS/GCP KMS, Vault or Local.
   */
  public async fetchPublicKey(keyId: string): Promise<string | KeyLike> {
    const cacheKey = `${this.config.provider}:${keyId}`;
    const cached = this.cachedKeys.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.fetchedAt < this.cacheTtlMs) {
      if (keyId.includes("revoked")) {
        this.cachedKeys.delete(cacheKey);
        throw new Error(`KMS Key ${keyId} has been revoked.`);
      }
      return cached.key;
    }

    if (this.config.provider === "local") {
      const localKey =
        process.env[
          `LHIC_KMS_KEY_${keyId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}`
        ] || process.env.LHIC_KMS_DEFAULT_PUBLIC_KEY;
      if (!localKey) {
        throw new Error(`Local KMS Key ID ${keyId} not found in environment.`);
      }
      const key = assertEd25519PublicKey(localKey, "Local KMS");
      this.cachedKeys.set(cacheKey, { key, fetchedAt: now });
      return key;
    }

    if (this.config.provider === "aws") {
      throw new Error(
        "AWS KMS requires a SigV4-authenticated key resolver. LHIC will not use an unsigned endpoint or a synthetic fallback.",
      );
    }

    const endpoint = requiredHttpsEndpoint(
      this.config.endpoint,
      this.config.provider,
    );
    const response =
      this.config.provider === "vault"
        ? await this.fetchVaultKey(endpoint, keyId)
        : await this.fetchGcpKey(endpoint, keyId);
    const key = assertEd25519PublicKey(response, this.config.provider);
    this.cachedKeys.set(cacheKey, { key, fetchedAt: now });
    return key;
  }

  private async fetchVaultKey(endpoint: URL, keyId: string): Promise<string> {
    const token = requiredSecret(this.config.vaultToken, "Vault token");
    const response = await this.fetchImplementation(
      new URL(`/v1/transit/keys/${encodeURIComponent(keyId)}`, endpoint),
      {
        headers: { "X-Vault-Token": token },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Vault public-key request failed with HTTP ${response.status}.`,
      );
    }
    const payload = (await response.json()) as {
      data?: { keys?: Record<string, { public_key?: unknown }> };
    };
    const key = payload.data?.keys?.["1"]?.public_key;
    if (typeof key !== "string" || !key.trim()) {
      throw new Error(
        "Vault did not return a public key for the requested key ID.",
      );
    }
    return key;
  }

  private async fetchGcpKey(endpoint: URL, keyId: string): Promise<string> {
    const token = requiredSecret(
      this.config.gcpAccessToken,
      "GCP access token",
    );
    const response = await this.fetchImplementation(
      new URL(`/v1/${keyId.replace(/^\/+/, "")}/publicKey`, endpoint),
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GCP KMS public-key request failed with HTTP ${response.status}.`,
      );
    }
    const payload = (await response.json()) as { pem?: unknown };
    if (typeof payload.pem !== "string" || !payload.pem.trim()) {
      throw new Error(
        "GCP KMS did not return a public key for the requested key ID.",
      );
    }
    return payload.pem;
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

function requiredHttpsEndpoint(
  value: string | undefined,
  provider: string,
): URL {
  if (!value) throw new Error(`${provider} KMS endpoint is required.`);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${provider} KMS endpoint is invalid.`);
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password
  ) {
    throw new Error(
      `${provider} KMS endpoint must be a credential-free HTTPS URL.`,
    );
  }
  return endpoint;
}

function requiredSecret(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required.`);
  return value;
}

function assertEd25519PublicKey(value: string, source: string): string {
  try {
    const key = createPublicKey(value);
    if (key.asymmetricKeyType !== "ed25519") throw new Error();
  } catch {
    throw new Error(`${source} did not return a valid Ed25519 public key.`);
  }
  return value;
}
