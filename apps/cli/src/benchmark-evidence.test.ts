import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { BenchmarkEvidenceManifest } from "@lhic/schema";

import {
  createBenchmarkEvidenceManifest,
  signBenchmarkEvidenceManifest,
  validateBenchmarkEvidenceBundle,
  verifyBenchmarkEvidenceManifest,
} from "./benchmark-evidence.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function input() {
  return {
    lhicCommit: "a".repeat(40),
    ompVersion: "17.2.15",
    ompSha256: "b".repeat(64),
    modelId: "openai-codex/gpt-5.6-sol",
    benchmark: "osworld",
    benchmarkRevision: "c".repeat(40),
    evaluatorRevision: "d".repeat(40),
    fixtureOrDatasetSha256: "e".repeat(64),
    runnerSha256: "f".repeat(64),
    os: "linux",
    arch: "arm64",
    runtime: "v24.0.0",
    configurationSha256: "cafe".repeat(16),
    resultArtifacts: [
      { path: "results/run-1.json", sha256: "deadbeef".repeat(8) },
    ],
  };
}

describe("benchmark evidence manifests", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-evidence-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("creates, signs, and verifies a manifest", () => {
    const manifest = createBenchmarkEvidenceManifest(input());
    const signed = signBenchmarkEvidenceManifest(manifest, privateKey, {
      keyId: "evidence-key-1",
    });
    expect(signed.signature).toBeDefined();
    expect(signed.signerKeyId).toBe("evidence-key-1");
    expect(verifyBenchmarkEvidenceManifest(signed, publicKey)).toBe(true);
    // Tampering with the manifest invalidates the signature.
    const tampered = { ...signed, ompVersion: "18.0.0" };
    expect(verifyBenchmarkEvidenceManifest(tampered, publicKey)).toBe(false);
    // Unsigned manifests fail signature verification.
    expect(verifyBenchmarkEvidenceManifest(manifest, publicKey)).toBe(false);
  });

  it("validates artifact presence and hashes", async () => {
    await mkdir(join(directory, "results"), { recursive: true });
    await writeFile(join(directory, "results", "run-1.json"), "{}");
    const digest = createHash("sha256").update("{}").digest("hex");
    const manifest = createBenchmarkEvidenceManifest({
      ...input(),
      resultArtifacts: [{ path: "results/run-1.json", sha256: digest }],
    });
    const result = await validateBenchmarkEvidenceBundle(manifest, {
      artifactsDirectory: directory,
    });
    expect(result.valid).toBe(true);
    // A mutated artifact fails the gate.
    await writeFile(join(directory, "results", "run-1.json"), "{mutated}");
    const mutated = await validateBenchmarkEvidenceBundle(manifest, {
      artifactsDirectory: directory,
    });
    expect(mutated.valid).toBe(false);
    expect(mutated.errors.join()).toMatch(/SHA-256 mismatch/);
    // A missing artifact fails the gate.
    await rm(join(directory, "results", "run-1.json"));
    const missing = await validateBenchmarkEvidenceBundle(manifest, {
      artifactsDirectory: directory,
    });
    expect(missing.valid).toBe(false);
    expect(missing.errors.join()).toMatch(/missing/);
  });

  it("fails validation on wrong identities and schema violations", async () => {
    const manifest = {
      ...createBenchmarkEvidenceManifest(input()),
      ompSha256: "not-a-hash",
    } as BenchmarkEvidenceManifest;
    const result = await validateBenchmarkEvidenceBundle(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects invalid key material and empty artifact entries", async () => {
    const manifest = createBenchmarkEvidenceManifest(input());
    expect(
      verifyBenchmarkEvidenceManifest(
        { ...manifest, signature: "!!!" },
        publicKey,
      ),
    ).toBe(false);
  });
});
