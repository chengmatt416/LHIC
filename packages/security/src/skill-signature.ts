import { sign, verify, type KeyLike } from "node:crypto";
import { createHash } from "node:crypto";

import {
  isSharedSkillProvenance,
  type SharedSkillProvenance,
} from "@lhic/schema";
import { canonicalSerialize } from "@lhic/trace";

export interface SharedSkillSigningOptions {
  publisher: string;
  publisherKeyId: string;
  verifierVersion: string;
  requiredLhicVersion: string;
  evaluationSummary: { independentRuns: number; holdoutPassed: boolean };
}

/**
 * Signs a shared-skill definition: the provenance binds the definition's
 * SHA-256, publisher identity, and evaluation summary. A modified definition
 * invalidates the signature; a remote registry can never silently replace an
 * already trusted local skill.
 */
export function createSharedSkillProvenance(
  definition: unknown,
  privateKey: KeyLike,
  options: SharedSkillSigningOptions,
): SharedSkillProvenance {
  const definitionSha256 = createHash("sha256")
    .update(canonicalSerialize(definition))
    .digest("hex");
  const payload = {
    definitionSha256,
    publisher: options.publisher,
    publisherKeyId: options.publisherKeyId,
    evaluationSummary: options.evaluationSummary,
  };
  const provenance: SharedSkillProvenance = {
    schemaVersion: "lhic-shared-skill-provenance-v1",
    definitionSha256,
    publisher: options.publisher,
    publisherKeyId: options.publisherKeyId,
    signature: sign(
      null,
      Buffer.from(canonicalSerialize(payload), "utf8"),
      privateKey,
    ).toString("base64"),
    verifierVersion: options.verifierVersion,
    requiredLhicVersion: options.requiredLhicVersion,
    evaluationSummary: options.evaluationSummary,
  };
  return provenance;
}

/**
 * Verifies a shared-skill provenance against a public key. Returns false for
 * malformed provenance, mismatched definitions, or invalid signatures —
 * unknown state never authorizes trusted use.
 */
export function verifySharedSkillProvenance(
  definition: unknown,
  provenance: SharedSkillProvenance | undefined,
  publicKey: KeyLike,
): boolean {
  if (!provenance || !isSharedSkillProvenance(provenance)) return false;
  const definitionSha256 = createHash("sha256")
    .update(canonicalSerialize(definition))
    .digest("hex");
  if (definitionSha256 !== provenance.definitionSha256) return false;
  const payload = {
    definitionSha256: provenance.definitionSha256,
    publisher: provenance.publisher,
    publisherKeyId: provenance.publisherKeyId,
    evaluationSummary: provenance.evaluationSummary,
  };
  try {
    return verify(
      null,
      Buffer.from(canonicalSerialize(payload), "utf8"),
      publicKey,
      Buffer.from(provenance.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export interface SharedSkillTrustDecision {
  trusted: boolean;
  reason: string;
}

/**
 * Explicit trust-root check: an unknown publisher stays untrusted until
 * explicitly approved, and a revoked key disqualifies the skill.
 */
export function decideSharedSkillTrust(
  provenance: SharedSkillProvenance | undefined,
  options: {
    trustedPublishers: ReadonlySet<string>;
    revokedKeyIds: ReadonlySet<string>;
  },
): SharedSkillTrustDecision {
  if (!provenance) {
    return { trusted: false, reason: "Skill carries no provenance." };
  }
  if (options.revokedKeyIds.has(provenance.publisherKeyId)) {
    return { trusted: false, reason: "Publisher key is revoked." };
  }
  if (!options.trustedPublishers.has(provenance.publisher)) {
    return {
      trusted: false,
      reason: `Publisher ${provenance.publisher} is not an approved trust root.`,
    };
  }
  return { trusted: true, reason: "Publisher is an approved trust root." };
}
