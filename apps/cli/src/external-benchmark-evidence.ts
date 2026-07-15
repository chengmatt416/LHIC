import { readFile } from "node:fs/promises";

export const supportedExternalBenchmarks = [
  "WebArena",
  "WorkArena",
  "OSWorld",
] as const;

export type ExternalBenchmarkName =
  (typeof supportedExternalBenchmarks)[number];

export interface ExternalBenchmarkEvidence {
  benchmark: ExternalBenchmarkName;
  benchmarkVersion: string;
  benchmarkCommit: string;
  fullSuite: boolean;
  taskCount: number;
  seed: number;
  completedAt: string;
  candidate: {
    name: string;
    version: string;
    successRate: number;
  };
  comparator: {
    name: string;
    successRate: number;
    leaderboardUrl: string;
    observedAt: string;
  };
  runner: {
    imageDigest: string;
    command: string;
  };
  artifacts: {
    resultUrl: string;
    sha256: string;
  };
  independentReproductionUrl?: string;
}

export interface BenchmarkEvidenceValidation {
  valid: boolean;
  errors: string[];
  candidateOutperformsComparator: boolean;
  independentlyReproduced: boolean;
  sotaClaimAllowed: false;
  conclusion: string;
}

export async function readExternalBenchmarkEvidence(
  filePath: string,
): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export function validateExternalBenchmarkEvidence(
  input: unknown,
): BenchmarkEvidenceValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return invalidEvidence(["Evidence must be a JSON object."]);
  }
  const evidence = input as Partial<ExternalBenchmarkEvidence>;
  if (
    !supportedExternalBenchmarks.includes(
      evidence.benchmark as ExternalBenchmarkName,
    )
  ) {
    errors.push("benchmark must be WebArena, WorkArena, or OSWorld.");
  }
  if (!isNonEmptyString(evidence.benchmarkVersion)) {
    errors.push("benchmarkVersion is required.");
  }
  if (!/^[a-f0-9]{7,64}$/i.test(evidence.benchmarkCommit ?? "")) {
    errors.push("benchmarkCommit must be a Git commit hash.");
  }
  if (evidence.fullSuite !== true) {
    errors.push("fullSuite must be true for a comparable SOTA evaluation.");
  }
  if (
    !Number.isSafeInteger(evidence.taskCount) ||
    (evidence.taskCount ?? 0) <= 0
  ) {
    errors.push("taskCount must be a positive integer.");
  }
  if (!Number.isSafeInteger(evidence.seed)) {
    errors.push("seed must be a safe integer.");
  }
  if (!isValidDate(evidence.completedAt)) {
    errors.push("completedAt must be an ISO-parseable timestamp.");
  }
  validateScore(
    "candidate.successRate",
    evidence.candidate?.successRate,
    errors,
  );
  validateScore(
    "comparator.successRate",
    evidence.comparator?.successRate,
    errors,
  );
  if (
    !isNonEmptyString(evidence.candidate?.name) ||
    !isNonEmptyString(evidence.candidate?.version)
  ) {
    errors.push("candidate name and version are required.");
  }
  if (!isNonEmptyString(evidence.comparator?.name)) {
    errors.push("comparator name is required.");
  }
  if (!isHttpsUrl(evidence.comparator?.leaderboardUrl)) {
    errors.push("comparator.leaderboardUrl must be an HTTPS URL.");
  }
  if (!isValidDate(evidence.comparator?.observedAt)) {
    errors.push("comparator.observedAt must be an ISO-parseable timestamp.");
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(evidence.runner?.imageDigest ?? "")) {
    errors.push("runner.imageDigest must be a sha256 image digest.");
  }
  if (!isNonEmptyString(evidence.runner?.command)) {
    errors.push("runner.command is required.");
  }
  if (!isHttpsUrl(evidence.artifacts?.resultUrl)) {
    errors.push("artifacts.resultUrl must be an HTTPS URL.");
  }
  if (!/^[a-f0-9]{64}$/i.test(evidence.artifacts?.sha256 ?? "")) {
    errors.push("artifacts.sha256 must be a SHA-256 digest.");
  }
  if (
    evidence.independentReproductionUrl !== undefined &&
    !isHttpsUrl(evidence.independentReproductionUrl)
  ) {
    errors.push(
      "independentReproductionUrl must be an HTTPS URL when supplied.",
    );
  }

  const candidateOutperformsComparator =
    typeof evidence.candidate?.successRate === "number" &&
    typeof evidence.comparator?.successRate === "number" &&
    evidence.candidate.successRate > evidence.comparator.successRate;
  if (!candidateOutperformsComparator) {
    errors.push(
      "Candidate success rate does not exceed the recorded comparator.",
    );
  }

  const independentlyReproduced = isHttpsUrl(
    evidence.independentReproductionUrl,
  );
  const valid = errors.length === 0;
  return {
    valid,
    errors,
    candidateOutperformsComparator,
    independentlyReproduced,
    sotaClaimAllowed: false,
    conclusion: valid
      ? "Evidence is complete enough for independent review; local validation alone never establishes a market SOTA claim."
      : "Evidence is incomplete or non-comparable; no performance claim is allowed.",
  };
}

function invalidEvidence(errors: string[]): BenchmarkEvidenceValidation {
  return {
    valid: false,
    errors,
    candidateOutperformsComparator: false,
    independentlyReproduced: false,
    sotaClaimAllowed: false,
    conclusion:
      "Evidence is incomplete or non-comparable; no performance claim is allowed.",
  };
}

function validateScore(
  name: string,
  value: number | undefined,
  errors: string[],
): void {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    errors.push(`${name} must be a fraction between 0 and 1.`);
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
