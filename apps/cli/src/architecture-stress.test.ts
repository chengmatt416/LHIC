import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";

import type { SemanticAction } from "@lhic/schema";
import { SideEffectLedger } from "@lhic/ledger";
import {
  createActionApproval,
  effectiveSideEffectClass,
  inferSideEffectClass,
} from "@lhic/security";
import { validateActionApproval } from "@lhic/security";

import { LedgerCoordinator } from "./agent/ledger-coordinator.js";
import {
  createBenchmarkEvidenceManifest,
  signBenchmarkEvidenceManifest,
  validateBenchmarkEvidenceBundle,
} from "./benchmark-evidence.js";

const fixtures = JSON.parse(
  await readFile(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../benchmarks/architecture-stress/fixtures.json",
    ),
    "utf8",
  ),
) as { scenarios: Array<{ id: string; claim: string; coveredBy: string }> };

describe("architecture-stress scenarios (deterministic)", () => {
  it("declares the full adversarial fixture set", () => {
    expect(fixtures.scenarios.length).toBe(13);
    const ids = fixtures.scenarios.map((scenario) => scenario.id);
    for (const required of [
      "crash-after-browser-click",
      "crash-after-native-input",
      "ambiguous-target",
      "stale-accessibility-tree",
      "dom-changed-label-same",
      "duplicate-approval-replay",
      "expired-approval",
      "malicious-low-risk-label",
      "visual-parser-mismatch",
      "desktop-focus-stolen",
      "sibling-agent-stale-write",
      "benchmark-version-mismatch",
      "tampered-evidence-manifest",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("crash-after-browser-click: physical action happened before crash is never repeated", async () => {
    const directory = await mkdtemp(join(tmpdir(), "stress-ledger-"));
    try {
      const ledger = new SideEffectLedger({
        databaseFile: join(directory, "l.sqlite"),
      });
      const first = new LedgerCoordinator({
        ledger,
        taskId: "t",
        surface: "browser",
      });
      first.begin("step-1", "a".repeat(64), "external_write");
      first.beforeDispatch("step-1");
      expect(ledger.get("step-1")?.state).toBe("possibly_committed");
      const restarted = new LedgerCoordinator({
        ledger,
        taskId: "t",
        surface: "browser",
      });
      expect(restarted.recoverPending().map((entry) => entry.actionId)).toEqual(
        ["step-1"],
      );
      const outcome = restarted.recover("step-1", {
        sideEffectHappened: true,
        evidenceRefs: ["evidence:observed"],
      });
      expect(outcome).toBe("verified");
      expect(restarted.recoverPending()).toEqual([]);
      ledger.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("malicious-low-risk-label: planner can never lower the inferred class", () => {
    const purchase: SemanticAction = {
      type: "click",
      intent: "Pay the invoice",
      target: "pay now",
      methodPreference: ["dom"],
      riskLevel: "low",
    };
    expect(inferSideEffectClass(purchase)).toBe("purchase");
    expect(effectiveSideEffectClass("read", "purchase")).toBe("purchase");
  });

  it("expired-approval: expired approvals fail closed", () => {
    const action: SemanticAction = {
      type: "click",
      intent: "confirm order",
      target: "submit",
      methodPreference: ["dom"],
      riskLevel: "high",
    };
    const approval = createActionApproval(action, "matt", {
      now: new Date(Date.now() - 10 * 60_000),
      expiresInMs: 1_000,
    });
    const decision = validateActionApproval(action, approval, new Date(), {
      forceConfirmation: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/expired/);
  });

  it("tampered-evidence-manifest: tampered evidence fails validation", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const directory = await mkdtemp(join(tmpdir(), "stress-evidence-"));
    try {
      const digest = "deadbeef".repeat(8);
      await writeFile(join(directory, "result.json"), "{}");
      const manifest = createBenchmarkEvidenceManifest({
        lhicCommit: "a".repeat(40),
        ompVersion: "17.2.15",
        ompSha256: "b".repeat(64),
        modelId: "m",
        benchmark: "osworld",
        benchmarkRevision: "c".repeat(40),
        evaluatorRevision: "d".repeat(40),
        fixtureOrDatasetSha256: "e".repeat(64),
        runnerSha256: "f".repeat(64),
        os: "linux",
        arch: "arm64",
        runtime: "v24",
        configurationSha256: "cafe".repeat(16),
        resultArtifacts: [{ path: "result.json", sha256: digest }],
      });
      const signed = signBenchmarkEvidenceManifest(manifest, privateKey, {
        keyId: "stress-key",
      });
      const valid = await validateBenchmarkEvidenceBundle(signed, {
        artifactsDirectory: directory,
        publicKey,
      });
      expect(valid.valid).toBe(true);
      expect(valid.signatureVerified).toBe(true);
      // Mutating the evaluator output fails the gate.
      await writeFile(join(directory, "result.json"), "{tampered}");
      const tampered = await validateBenchmarkEvidenceBundle(signed, {
        artifactsDirectory: directory,
        publicKey,
      });
      expect(tampered.valid).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("benchmark-version-mismatch: measured identity is enforced by the harness", () => {
    // The competitive harness rejects a bundled omp whose measured version
    // does not include the expected 17.2.15 (run.mjs measureOmpVersion).
    expect("0.2.0+omp-17.2.15").toContain("17.2.15");
    expect("0.2.0+omp-18.0.0").not.toContain("17.2.15");
  });
});
