import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { MemoryRecord, SharedSkillProvenance } from "@lhic/schema";
import {
  createSharedSkillProvenance,
  decideSharedSkillTrust,
  verifySharedSkillProvenance,
} from "@lhic/security";

import { TrustedMemoryStore } from "./trusted-memory.js";

describe("TrustedMemoryStore", () => {
  let directory: string;
  let store: TrustedMemoryStore;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-memory-"));
    store = new TrustedMemoryStore({
      databaseFile: join(directory, "memory.sqlite"),
    });
  });

  afterEach(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
    return {
      schemaVersion: "lhic-memory-v1",
      id: "mem-1",
      namespace: "coding_context",
      trust: "model_extracted",
      contentHash: "a".repeat(64),
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("persists and retrieves records with trust labels", () => {
    store.save(record());
    const loaded = store.get("mem-1");
    expect(loaded?.trust).toBe("model_extracted");
    expect(loaded?.namespace).toBe("coding_context");
    expect(store.listByNamespace("coding_context")).toHaveLength(1);
  });

  it("rejects malformed records at the boundary", () => {
    expect(() =>
      store.save({
        ...record(),
        schemaVersion: "lhic-memory-v9",
      } as unknown as MemoryRecord),
    ).toThrow(/malformed memory record/);
  });

  it("Fast Path eligibility is limited to verifier-backed or shared-signed", () => {
    const now = new Date();
    expect(
      TrustedMemoryStore.fastPathEligible(
        record({ trust: "verifier_backed", namespace: "verified_skill" }),
        now,
      ),
    ).toBe(true);
    expect(
      TrustedMemoryStore.fastPathEligible(
        record({ trust: "shared_signed" }),
        now,
      ),
    ).toBe(true);
    expect(
      TrustedMemoryStore.fastPathEligible(
        record({ trust: "model_extracted" }),
        now,
      ),
    ).toBe(false);
    expect(
      TrustedMemoryStore.fastPathEligible(
        record({
          trust: "verifier_backed",
          staleAfter: "2020-01-01T00:00:00.000Z",
        }),
        now,
      ),
    ).toBe(false);
    store.save(record({ trust: "verifier_backed" }));
    store.invalidate("mem-1", "code changed");
    expect(TrustedMemoryStore.fastPathEligible(store.get("mem-1")!, now)).toBe(
      false,
    );
  });

  it("labels retrieval source so lower-trust memory is never masked", () => {
    expect(TrustedMemoryStore.retrievalLabel(record())).toBe(
      "coding_context:model_extracted",
    );
  });

  it("checks code anchors and reduces confidence on change", async () => {
    const anchored: MemoryRecord = record({
      trust: "verifier_backed",
      codeAnchor: {
        repoId: "repo-1",
        paths: ["src/a.ts"],
        pathHashes: { "src/a.ts": "hash-old" },
      },
      confidence: 0.9,
    });
    const freshness = await TrustedMemoryStore.checkAnchorFreshness(
      anchored.codeAnchor!,
      async (path) => (path === "src/a.ts" ? "hash-old" : undefined),
    );
    expect(freshness.status).toBe("fresh");
    const changed = await TrustedMemoryStore.checkAnchorFreshness(
      anchored.codeAnchor!,
      async () => "hash-new",
    );
    expect(changed.status).toBe("changed");
    expect(changed.confidence).toBe(0.1);
    const missing = await TrustedMemoryStore.checkAnchorFreshness(
      anchored.codeAnchor!,
      async () => undefined,
    );
    expect(missing.status).toBe("missing");
  });
});

describe("shared skill provenance", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const definition = {
    compiler: "shared-skill-v1",
    actions: [{ type: "click", intent: "continue" }],
  };

  function provenance(): SharedSkillProvenance {
    return createSharedSkillProvenance(definition, privateKey, {
      publisher: "publisher-a",
      publisherKeyId: "key-1",
      verifierVersion: "lhic-verifier-v1",
      requiredLhicVersion: "0.1.0",
      evaluationSummary: { independentRuns: 3, holdoutPassed: true },
    });
  }

  it("verifies a genuine signature and rejects a modified definition", () => {
    const signed = provenance();
    expect(verifySharedSkillProvenance(definition, signed, publicKey)).toBe(
      true,
    );
    const tampered = {
      ...definition,
      actions: [{ type: "click", intent: "delete everything" }],
    };
    expect(verifySharedSkillProvenance(tampered, signed, publicKey)).toBe(
      false,
    );
  });

  it("rejects malformed or missing provenance", () => {
    expect(verifySharedSkillProvenance(definition, undefined, publicKey)).toBe(
      false,
    );
    const bad = { ...provenance(), signature: "not-base64!!" };
    expect(verifySharedSkillProvenance(definition, bad, publicKey)).toBe(false);
  });

  it("requires an approved publisher and rejects revoked keys", () => {
    const signed = provenance();
    expect(
      decideSharedSkillTrust(signed, {
        trustedPublishers: new Set(["publisher-a"]),
        revokedKeyIds: new Set(),
      }).trusted,
    ).toBe(true);
    expect(
      decideSharedSkillTrust(signed, {
        trustedPublishers: new Set(["other"]),
        revokedKeyIds: new Set(),
      }).trusted,
    ).toBe(false);
    expect(
      decideSharedSkillTrust(signed, {
        trustedPublishers: new Set(["publisher-a"]),
        revokedKeyIds: new Set(["key-1"]),
      }).trusted,
    ).toBe(false);
    expect(
      decideSharedSkillTrust(undefined, {
        trustedPublishers: new Set(["publisher-a"]),
        revokedKeyIds: new Set(),
      }).trusted,
    ).toBe(false);
  });
});
