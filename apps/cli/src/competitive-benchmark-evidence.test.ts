import { describe, expect, it } from "vitest";

import {
  validateCompetitiveBenchmarkEvidence,
  type CompetitiveBenchmarkRun,
} from "./competitive-benchmark-evidence.js";

const digest = "a".repeat(64);
const tasks = [
  ["coding-sort-stability", "coding"],
  ["coding-atomic-counter", "coding"],
  ["coding-path-containment", "coding"],
  ["coding-stream-lines", "coding"],
  ["browser-semantic-search", "browser"],
  ["browser-form-validation", "browser"],
  ["browser-stale-list", "browser"],
  ["browser-dialog-recovery", "browser"],
  ["desktop-editor-save", "desktop"],
  ["desktop-stale-button", "desktop"],
  ["desktop-retry-resume", "desktop"],
  ["desktop-approval-boundary", "desktop"],
] as const;

function runs(
  product: "lhic" | "goose",
  passed: number,
  approvals: number,
): CompetitiveBenchmarkRun[] {
  let runIndex = 0;
  return tasks.flatMap(([taskId, category]) =>
    Array.from({ length: 5 }, (_, repetition) => {
      const verifierPassed = runIndex++ < passed;
      return {
        taskId,
        category,
        repetition,
        seed: repetition,
        product,
        track: "shared-capability",
        status: verifierPassed ? "passed" : "failed",
        modelId: "openai-codex/gpt-5.6-sol",
        binaryVersion: product === "lhic" ? "0.2.0" : "1.46.0",
        binarySha256: digest,
        fixtureSha256: digest,
        artifactSha256: digest,
        wallTimeMs: 100,
        turns: 2,
        approvals,
        retries: 0,
        duplicateVerifiedActions: 0,
        verifierPassed,
      };
    }),
  );
}

const evidence = {
  schemaVersion: "lhic-agent-competitive-v1",
  generatedAt: "2026-08-13T00:00:00.000Z",
  fixtureSetSha256: digest,
  runs: [...runs("lhic", 54, 1), ...runs("goose", 45, 1)],
};

describe("competitive benchmark evidence", () => {
  it("allows only a pinned suite-scoped claim with complete five-run coverage", () => {
    expect(
      validateCompetitiveBenchmarkEvidence(evidence, "goose"),
    ).toMatchObject({
      valid: true,
      claimAllowed: true,
      sotaClaimAllowed: false,
      candidateSuccessRate: 0.9,
      comparatorSuccessRate: 0.75,
    });
  });

  it("rejects model mismatch, approval regressions, and duplicate actions", () => {
    const broken = structuredClone(evidence);
    for (const run of broken.runs) {
      if (run.product === "lhic") run.approvals = 2;
      if (run.product === "goose") run.approvals = 0;
    }
    const goose = broken.runs.find((run) => run.product === "goose")!;
    goose.modelId = "different-model";
    const lhic = broken.runs.find((run) => run.product === "lhic")!;
    lhic.duplicateVerifiedActions = 1;
    expect(validateCompetitiveBenchmarkEvidence(broken, "goose")).toMatchObject(
      {
        valid: false,
        claimAllowed: false,
        errors: expect.arrayContaining([
          expect.stringContaining("identical exact model"),
          expect.stringContaining("median human approvals"),
          expect.stringContaining("duplicate zero verified actions"),
        ]),
      },
    );
  });

  it("keeps not-run comparator placeholders non-comparable", () => {
    const placeholder = structuredClone(evidence);
    placeholder.runs = placeholder.runs.map((run) =>
      run.product === "goose"
        ? { ...run, status: "not-run" as const, verifierPassed: false }
        : run,
    );
    expect(
      validateCompetitiveBenchmarkEvidence(placeholder, "goose"),
    ).toMatchObject({
      valid: false,
      claimAllowed: false,
      errors: expect.arrayContaining([
        expect.stringContaining("non-comparable run statuses"),
      ]),
    });
  });
});
