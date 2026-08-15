import { sign, verify, type KeyLike } from "node:crypto";

import { canonicalSerialize } from "@lhic/trace";
import { createHash } from "node:crypto";

/**
 * Generic Ed25519 signing over canonical serialization, used for benchmark
 * evidence manifests and shared-skill provenance. Canonical bytes keep
 * signatures stable regardless of key order or formatting.
 */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}

export interface SignedEvidence {
  payload: unknown;
  signature: string;
  signerKeyId?: string;
}

export function signEvidence(
  payload: unknown,
  privateKey: KeyLike,
  options: { keyId?: string } = {},
): SignedEvidence {
  return {
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalSerialize(payload), "utf8"),
      privateKey,
    ).toString("base64"),
    ...(options.keyId ? { signerKeyId: options.keyId } : {}),
  };
}

export function verifyEvidenceSignature(
  payload: unknown,
  signature: string,
  publicKey: KeyLike,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalSerialize(payload), "utf8"),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

/** Canonical manifest digest used as the signature input's identity. */
export function evidenceDigest(payload: unknown): string {
  return canonicalSha256(payload);
}
