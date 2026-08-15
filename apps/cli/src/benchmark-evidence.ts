import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyLike,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  isBenchmarkEvidenceManifest,
  type BenchmarkEvidenceManifest,
} from "@lhic/schema";
import { canonicalSerialize } from "@lhic/trace";

export interface BenchmarkEvidenceInput {
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
  configurationSha256: string;
  resultArtifacts: Array<{ path: string; sha256: string }>;
}

/**
 * Creates a signed benchmark evidence manifest with pinned identities.
 * `resultArtifacts` entries are serialized as "<path>:<sha256>".
 */
export function createBenchmarkEvidenceManifest(
  input: BenchmarkEvidenceInput,
  now = new Date(),
): BenchmarkEvidenceManifest {
  const manifest: BenchmarkEvidenceManifest = {
    schemaVersion: "lhic-benchmark-evidence-v1",
    lhicCommit: input.lhicCommit,
    ompVersion: input.ompVersion,
    ompSha256: input.ompSha256,
    modelId: input.modelId,
    benchmark: input.benchmark,
    benchmarkRevision: input.benchmarkRevision,
    evaluatorRevision: input.evaluatorRevision,
    fixtureOrDatasetSha256: input.fixtureOrDatasetSha256,
    runnerSha256: input.runnerSha256,
    os: input.os,
    arch: input.arch,
    runtime: input.runtime,
    startedAt: new Date(now.getTime() - 1).toISOString(),
    completedAt: now.toISOString(),
    configurationSha256: input.configurationSha256,
    resultArtifacts: input.resultArtifacts.map(
      (artifact) => `${artifact.path}:${artifact.sha256}`,
    ),
  };
  if (!isBenchmarkEvidenceManifest(manifest)) {
    throw new Error("Refusing to emit an invalid benchmark evidence manifest.");
  }
  return manifest;
}

/** Signature payload: the manifest without its own signature fields. */
export function benchmarkManifestPayload(
  manifest: BenchmarkEvidenceManifest,
): Record<string, unknown> {
  const {
    signature: _signature,
    signerKeyId: _signerKeyId,
    signedAt: _signedAt,
    ...payload
  } = manifest;
  return payload;
}

export function signBenchmarkEvidenceManifest(
  manifest: BenchmarkEvidenceManifest,
  privateKey: KeyLike,
  options: { keyId?: string } = {},
): BenchmarkEvidenceManifest {
  const payload = benchmarkManifestPayload(manifest);
  return {
    ...manifest,
    signature: sign(
      null,
      Buffer.from(canonicalSerialize(payload), "utf8"),
      privateKey,
    ).toString("base64"),
    ...(options.keyId ? { signerKeyId: options.keyId } : {}),
    signedAt: new Date().toISOString(),
  };
}

export function verifyBenchmarkEvidenceManifest(
  manifest: BenchmarkEvidenceManifest,
  publicKey: KeyLike,
): boolean {
  if (!manifest.signature) return false;
  try {
    return verify(
      null,
      Buffer.from(
        canonicalSerialize(benchmarkManifestPayload(manifest)),
        "utf8",
      ),
      publicKey,
      Buffer.from(manifest.signature, "base64"),
    );
  } catch {
    return false;
  }
}

export interface BenchmarkBundleValidation {
  valid: boolean;
  errors: string[];
  signatureVerified: boolean;
}

/**
 * Validates an evidence bundle: manifest schema, pinned identities, artifact
 * presence and SHA-256, and (when a public key is provided) the signature.
 * A mutated artifact or executable breaks the gate.
 */
export async function validateBenchmarkEvidenceBundle(
  manifest: BenchmarkEvidenceManifest,
  options: {
    artifactsDirectory?: string;
    publicKey?: KeyLike;
  } = {},
): Promise<BenchmarkBundleValidation> {
  const errors: string[] = [];
  if (!isBenchmarkEvidenceManifest(manifest)) {
    return {
      valid: false,
      errors: ["Manifest does not satisfy the schema."],
      signatureVerified: false,
    };
  }
  if (!/^[a-f0-9]{7,64}$/i.test(manifest.lhicCommit)) {
    errors.push("lhicCommit must be a commit SHA.");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.ompSha256)) {
    errors.push("ompSha256 must be a SHA-256 digest.");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.fixtureOrDatasetSha256)) {
    errors.push("fixtureOrDatasetSha256 must be a SHA-256 digest.");
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.runnerSha256)) {
    errors.push("runnerSha256 must be a SHA-256 digest.");
  }
  if (Date.parse(manifest.completedAt) < Date.parse(manifest.startedAt)) {
    errors.push("completedAt precedes startedAt.");
  }
  if (options.artifactsDirectory) {
    for (const entry of manifest.resultArtifacts) {
      const [path, expected] = splitArtifactEntry(entry);
      if (!path || !expected) {
        errors.push(`Malformed artifact entry: ${entry}`);
        continue;
      }
      const artifactPath = join(options.artifactsDirectory, path);
      try {
        const fileStats = await stat(artifactPath);
        if (!fileStats.isFile()) {
          errors.push(`Artifact is not a regular file: ${path}`);
          continue;
        }
        const digest = createHash("sha256")
          .update(await readFile(artifactPath))
          .digest("hex");
        if (digest !== expected) {
          errors.push(`Artifact SHA-256 mismatch: ${path}`);
        }
      } catch {
        errors.push(`Artifact missing: ${path}`);
      }
    }
  }
  let signatureVerified = false;
  if (options.publicKey) {
    signatureVerified = verifyBenchmarkEvidenceManifest(
      manifest,
      options.publicKey,
    );
    if (!signatureVerified) {
      errors.push("Manifest signature is missing or invalid.");
    }
  }
  return { valid: errors.length === 0, errors, signatureVerified };
}

export function splitArtifactEntry(
  entry: string,
): [string | undefined, string | undefined] {
  const separator = entry.lastIndexOf(":");
  if (separator <= 0 || separator === entry.length - 1)
    return [undefined, undefined];
  const path = entry.slice(0, separator);
  const sha256 = entry.slice(separator + 1);
  return /^[a-f0-9]{64}$/.test(sha256)
    ? [path, sha256]
    : [undefined, undefined];
}

export function loadKeyFromFile(
  path: string,
  kind: "public" | "private",
): KeyLike {
  const material = readFileSync(path, "utf8");
  return kind === "public"
    ? createPublicKey(material)
    : createPrivateKey(material);
}

export async function runBenchmarkEvidenceSign(
  argumentsList: string[],
): Promise<number> {
  const manifestPath = argumentsList[0];
  if (!manifestPath) throw new Error("evidence-sign requires a manifest file.");
  let keyPath: string | undefined;
  let keyId: string | undefined;
  for (let index = 1; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--key" && argumentsList[index + 1]) {
      keyPath = argumentsList[index + 1];
      index += 1;
    } else if (
      argumentsList[index] === "--key-id" &&
      argumentsList[index + 1]
    ) {
      keyId = argumentsList[index + 1];
      index += 1;
    }
  }
  if (!keyPath) {
    keyPath = process.env.LHIC_EVIDENCE_SIGNING_KEY_FILE;
  }
  if (!keyPath)
    throw new Error(
      "evidence-sign requires --key <file> or LHIC_EVIDENCE_SIGNING_KEY_FILE.",
    );
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as BenchmarkEvidenceManifest;
  const signed = signBenchmarkEvidenceManifest(
    manifest,
    loadKeyFromFile(keyPath, "private"),
    {
      ...(keyId ? { keyId } : {}),
    },
  );
  console.log(JSON.stringify(signed, null, 2));
  return 0;
}

export async function runBenchmarkEvidenceValidate(
  argumentsList: string[],
): Promise<number> {
  const manifestPath = argumentsList[0];
  if (!manifestPath)
    throw new Error("evidence-validate requires a manifest file.");
  let artifactsDirectory: string | undefined;
  let publicKeyPath: string | undefined;
  for (let index = 1; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === "--artifacts" && argumentsList[index + 1]) {
      artifactsDirectory = argumentsList[index + 1];
      index += 1;
    } else if (
      argumentsList[index] === "--public-key" &&
      argumentsList[index + 1]
    ) {
      publicKeyPath = argumentsList[index + 1];
      index += 1;
    }
  }
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as BenchmarkEvidenceManifest;
  const result = await validateBenchmarkEvidenceBundle(manifest, {
    ...(artifactsDirectory ? { artifactsDirectory } : {}),
    ...(publicKeyPath
      ? { publicKey: loadKeyFromFile(publicKeyPath, "public") }
      : {}),
  });
  console.log(JSON.stringify(result, null, 2));
  return result.valid ? 0 : 1;
}
