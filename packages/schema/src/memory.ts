/**
 * Memory trust model: namespaces never collapse into one undifferentiated
 * store, and trust is explicit per record. Fast Path retrieval may use only
 * verifier-backed or cryptographically verified shared records; everything
 * else is labeled and restricted to Slow Path/coding context.
 */
export interface CodeMemoryAnchor {
  repoId: string;
  commit?: string;
  paths: string[];
  pathHashes: Record<string, string>;
  symbols?: string[];
}

export interface MemoryRecord {
  schemaVersion: "lhic-memory-v1";
  id: string;
  namespace:
    | "verified_skill"
    | "selector"
    | "coding_context"
    | "user_fact"
    | "recipe_candidate";
  trust:
    | "verifier_backed"
    | "observed"
    | "model_extracted"
    | "user_provided"
    | "shared_signed";
  sourceTaskId?: string;
  sourceReceiptIds?: string[];
  contentHash: string;
  createdAt: string;
  staleAfter?: string;
  codeAnchor?: CodeMemoryAnchor;
  confidence?: number;
  invalidatedAt?: string;
  invalidationReason?: string;
}

/**
 * Provenance for a shared skill crossing the supply-chain boundary. The
 * definition SHA-256 is signed by the publisher; a modified definition
 * invalidates the signature, and an unknown publisher stays untrusted until
 * explicitly approved.
 */
export interface SharedSkillProvenance {
  schemaVersion: "lhic-shared-skill-provenance-v1";
  definitionSha256: string;
  publisher: string;
  publisherKeyId: string;
  signature: string;
  verifierVersion: string;
  requiredLhicVersion: string;
  evaluationSummary: {
    independentRuns: number;
    holdoutPassed: boolean;
  };
}

/** Verified recipe extracted from repeated independent verifier-backed runs. */
export interface VerifiedRecipe {
  schemaVersion: "lhic-recipe-v1";
  recipeId: string;
  goal: string;
  parameters: Array<{ name: string }>;
  steps: Array<{ action: unknown; verification: unknown }>;
  risk: { classes: string[] };
  evidence: {
    independentRuns: number;
    holdoutPassed: boolean;
    sourceTaskIds: string[];
  };
  definitionSha256: string;
  version: string;
  createdAt: string;
}

export function isMemoryRecord(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "lhic-memory-v1") return false;
  if (typeof record.id !== "string" || !record.id.trim()) return false;
  if (
    ![
      "verified_skill",
      "selector",
      "coding_context",
      "user_fact",
      "recipe_candidate",
    ].includes(String(record.namespace))
  ) {
    return false;
  }
  if (
    ![
      "verifier_backed",
      "observed",
      "model_extracted",
      "user_provided",
      "shared_signed",
    ].includes(String(record.trust))
  ) {
    return false;
  }
  if (
    typeof record.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.contentHash)
  ) {
    return false;
  }
  if (
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    return false;
  }
  return true;
}

export function isSharedSkillProvenance(
  value: unknown,
): value is SharedSkillProvenance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const provenance = value as Record<string, unknown>;
  if (provenance.schemaVersion !== "lhic-shared-skill-provenance-v1") {
    return false;
  }
  if (
    typeof provenance.definitionSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(provenance.definitionSha256) ||
    typeof provenance.publisher !== "string" ||
    !provenance.publisher.trim() ||
    typeof provenance.publisherKeyId !== "string" ||
    !provenance.publisherKeyId.trim() ||
    typeof provenance.signature !== "string" ||
    !provenance.signature.trim() ||
    typeof provenance.verifierVersion !== "string" ||
    typeof provenance.requiredLhicVersion !== "string"
  ) {
    return false;
  }
  const evaluation = provenance.evaluationSummary as
    Record<string, unknown> | undefined;
  if (!evaluation || typeof evaluation !== "object") return false;
  if (
    typeof evaluation.independentRuns !== "number" ||
    !Number.isSafeInteger(evaluation.independentRuns) ||
    evaluation.independentRuns < 0 ||
    typeof evaluation.holdoutPassed !== "boolean"
  ) {
    return false;
  }
  return true;
}
