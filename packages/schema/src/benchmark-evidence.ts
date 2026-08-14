/**
 * Signed benchmark evidence manifest. Every public evidence bundle carries
 * pinned identities (LHIC commit, OMP version + SHA-256, exact model ID,
 * benchmark and evaluator revisions) so "we ran this exact stack" is
 * verifiable. The manifest is signed; unsigned bundles are usable locally
 * but must be labeled unsigned.
 */
export interface BenchmarkEvidenceManifest {
  schemaVersion: "lhic-benchmark-evidence-v1";
  lhicCommit: string;
  ompVersion: string;
  ompSha256: string;
  modelId: string;
  benchmark: string;
  benchmarkRevision: string;
  evaluatorRevision: string;
  fixtureOrDatasetSha256: string;
  runnerSha256: string;
  os: string;
  arch: string;
  runtime: string;
  startedAt: string;
  completedAt: string;
  configurationSha256: string;
  resultArtifacts: string[];
  /** Optional detached signature over the canonical manifest (Ed25519). */
  signature?: string;
  signerKeyId?: string;
  signedAt?: string;
}

export function isBenchmarkEvidenceManifest(
  value: unknown,
): value is BenchmarkEvidenceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== "lhic-benchmark-evidence-v1") return false;
  for (const key of [
    "lhicCommit",
    "ompVersion",
    "ompSha256",
    "modelId",
    "benchmark",
    "benchmarkRevision",
    "evaluatorRevision",
    "fixtureOrDatasetSha256",
    "runnerSha256",
    "os",
    "arch",
    "runtime",
    "startedAt",
    "completedAt",
    "configurationSha256",
  ] as const) {
    if (typeof manifest[key] !== "string" || !manifest[key]) return false;
  }
  for (const key of [
    "ompSha256",
    "fixtureOrDatasetSha256",
    "runnerSha256",
    "configurationSha256",
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(String(manifest[key]))) return false;
  }
  if (!/^[a-f0-9]{7,64}$/i.test(String(manifest.lhicCommit))) return false;
  if (
    !Number.isFinite(Date.parse(String(manifest.startedAt))) ||
    !Number.isFinite(Date.parse(String(manifest.completedAt)))
  ) {
    return false;
  }
  if (
    !Array.isArray(manifest.resultArtifacts) ||
    !manifest.resultArtifacts.every((artifact) => typeof artifact === "string")
  ) {
    return false;
  }
  if (
    manifest.signature !== undefined &&
    typeof manifest.signature !== "string"
  ) {
    return false;
  }
  return true;
}
