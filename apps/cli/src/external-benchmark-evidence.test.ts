import { describe, expect, it } from "vitest";

import { validateExternalBenchmarkEvidence } from "./external-benchmark-evidence.js";

const evidence = {
  benchmark: "WorkArena",
  benchmarkVersion: "1.0.0",
  benchmarkCommit: "0123456789abcdef",
  fullSuite: true,
  taskCount: 341,
  seed: 42,
  completedAt: "2026-07-15T00:00:00.000Z",
  candidate: { name: "LHIC", version: "0.1.0", successRate: 0.91 },
  comparator: {
    name: "Recorded baseline",
    successRate: 0.9,
    leaderboardUrl: "https://example.test/leaderboard",
    observedAt: "2026-07-15T00:00:00.000Z",
  },
  runner: {
    imageDigest: `sha256:${"a".repeat(64)}`,
    command: "python -m agentlab.experiments.launch_exp",
  },
  artifacts: {
    resultUrl: "https://example.test/results.json",
    sha256: "b".repeat(64),
  },
};

describe("external benchmark evidence", () => {
  it("distinguishes complete review evidence from a SOTA claim", () => {
    expect(validateExternalBenchmarkEvidence(evidence)).toMatchObject({
      valid: true,
      candidateOutperformsComparator: true,
      independentlyReproduced: false,
      sotaClaimAllowed: false,
    });
  });

  it("rejects partial suites and unsupported score assertions", () => {
    expect(
      validateExternalBenchmarkEvidence({
        ...evidence,
        fullSuite: false,
        candidate: { ...evidence.candidate, successRate: 0.8 },
      }),
    ).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        expect.stringContaining("fullSuite"),
        expect.stringContaining("does not exceed"),
      ]),
    });
  });
});
