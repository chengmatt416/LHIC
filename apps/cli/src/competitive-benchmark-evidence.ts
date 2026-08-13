import { readFile } from "node:fs/promises";

export const competitiveProducts = ["lhic", "goose", "codex"] as const;
const competitiveTasks = new Map<string, CompetitiveBenchmarkRun["category"]>([
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
]);
export type CompetitiveProduct = (typeof competitiveProducts)[number];
export type CompetitiveTrack = "shared-capability" | "product-native";
export type CompetitiveRunStatus =
  | "passed"
  | "failed"
  | "timeout"
  | "denied"
  | "crashed"
  | "not-run"
  | "incomparable-model";

export interface CompetitiveBenchmarkRun {
  taskId: string;
  category: "coding" | "browser" | "desktop";
  repetition: number;
  seed: number;
  product: CompetitiveProduct;
  track: CompetitiveTrack;
  status: CompetitiveRunStatus;
  modelId: string;
  binaryVersion: string;
  binarySha256: string;
  fixtureSha256: string;
  artifactSha256: string;
  wallTimeMs: number;
  turns: number;
  approvals: number;
  retries: number;
  duplicateVerifiedActions: number;
  verifierPassed: boolean;
}

export interface CompetitiveBenchmarkEvidence {
  schemaVersion: "lhic-agent-competitive-v1";
  generatedAt: string;
  fixtureSetSha256: string;
  runs: CompetitiveBenchmarkRun[];
  independentReproductionUrl?: string;
}

export interface CompetitiveEvidenceValidation {
  valid: boolean;
  errors: string[];
  claimAllowed: boolean;
  sotaClaimAllowed: false;
  candidateSuccessRate: number;
  comparatorSuccessRate?: number;
  candidateMedianApprovals: number;
  comparatorMedianApprovals?: number;
  conclusion: string;
}

export async function readCompetitiveBenchmarkEvidence(
  filePath: string,
): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export function validateCompetitiveBenchmarkEvidence(
  input: unknown,
  comparator: Exclude<CompetitiveProduct, "lhic">,
  track: CompetitiveTrack = "shared-capability",
): CompetitiveEvidenceValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid(errors.concat("Evidence must be a JSON object."));
  }
  const evidence = input as Partial<CompetitiveBenchmarkEvidence>;
  if (evidence.schemaVersion !== "lhic-agent-competitive-v1") {
    errors.push("schemaVersion must be lhic-agent-competitive-v1.");
  }
  if (
    typeof evidence.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.generatedAt))
  ) {
    errors.push("generatedAt must be an ISO-parseable timestamp.");
  }
  if (!isSha256(evidence.fixtureSetSha256)) {
    errors.push("fixtureSetSha256 must be a SHA-256 digest.");
  }
  if (!Array.isArray(evidence.runs)) {
    errors.push("runs must be an array.");
    return invalid(errors);
  }
  for (const [index, run] of evidence.runs.entries()) {
    validateRun(run, index, errors);
  }
  const candidate = productRuns(evidence.runs, "lhic", track);
  const comparison = productRuns(evidence.runs, comparator, track);
  validateCoverage(candidate, "lhic", errors);
  validateCoverage(comparison, comparator, errors);
  validatePairs(candidate, comparison, errors);

  const candidateModels = new Set(candidate.map((run) => run.modelId));
  const comparatorModels = new Set(comparison.map((run) => run.modelId));
  if (
    candidateModels.size !== 1 ||
    comparatorModels.size !== 1 ||
    [...candidateModels][0] !== [...comparatorModels][0]
  ) {
    errors.push(
      "Candidate and comparator must use one identical exact model ID.",
    );
  }
  const candidateSuccessRate = successRate(candidate);
  const comparatorSuccessRate = successRate(comparison);
  const candidateMedianApprovals = median(
    candidate.map((run) => run.approvals),
  );
  const comparatorMedianApprovals = median(
    comparison.map((run) => run.approvals),
  );
  if (candidateSuccessRate - comparatorSuccessRate < 0.1) {
    errors.push(
      "LHIC success rate must exceed the comparator by at least 10 percentage points.",
    );
  }
  if (candidateMedianApprovals > comparatorMedianApprovals) {
    errors.push(
      "LHIC median human approvals must be no higher than the comparator.",
    );
  }
  if (candidate.some((run) => run.duplicateVerifiedActions !== 0)) {
    errors.push("LHIC crash-resume runs must duplicate zero verified actions.");
  }
  const claimAllowed = errors.length === 0;
  return {
    valid: claimAllowed,
    errors,
    claimAllowed,
    sotaClaimAllowed: false,
    candidateSuccessRate,
    comparatorSuccessRate,
    candidateMedianApprovals,
    comparatorMedianApprovals,
    conclusion: claimAllowed
      ? `Validated suite-scoped evidence permits: LHIC beats ${comparator} on this pinned suite.`
      : "Evidence is incomplete or non-comparable; no superiority claim is allowed.",
  };
}

function validateRun(value: unknown, index: number, errors: string[]): void {
  const prefix = `runs[${index}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${prefix} must be an object.`);
    return;
  }
  const run = value as Partial<CompetitiveBenchmarkRun>;
  if (typeof run.taskId !== "string" || !run.taskId)
    errors.push(`${prefix}.taskId is required.`);
  if (
    run.category !== "coding" &&
    run.category !== "browser" &&
    run.category !== "desktop"
  )
    errors.push(`${prefix}.category is invalid.`);
  if (!competitiveProducts.includes(run.product as CompetitiveProduct))
    errors.push(`${prefix}.product is invalid.`);
  if (run.track !== "shared-capability" && run.track !== "product-native")
    errors.push(`${prefix}.track is invalid.`);
  if (
    ![
      "passed",
      "failed",
      "timeout",
      "denied",
      "crashed",
      "not-run",
      "incomparable-model",
    ].includes(String(run.status))
  )
    errors.push(`${prefix}.status is invalid.`);
  for (const key of [
    "binarySha256",
    "fixtureSha256",
    "artifactSha256",
  ] as const) {
    if (!isSha256(run[key]))
      errors.push(`${prefix}.${key} must be a SHA-256 digest.`);
  }
  for (const key of [
    "repetition",
    "seed",
    "wallTimeMs",
    "turns",
    "approvals",
    "retries",
    "duplicateVerifiedActions",
  ] as const) {
    const number = run[key];
    if (!Number.isSafeInteger(number) || Number(number) < 0)
      errors.push(`${prefix}.${key} must be a non-negative integer.`);
  }
  if (typeof run.modelId !== "string" || !run.modelId)
    errors.push(`${prefix}.modelId is required.`);
  if (typeof run.binaryVersion !== "string" || !run.binaryVersion)
    errors.push(`${prefix}.binaryVersion is required.`);
  if (run.verifierPassed !== (run.status === "passed"))
    errors.push(`${prefix}.verifierPassed must exactly match passed status.`);
}

function productRuns(
  runs: CompetitiveBenchmarkRun[],
  product: CompetitiveProduct,
  track: CompetitiveTrack,
): CompetitiveBenchmarkRun[] {
  return runs.filter((run) => run.product === product && run.track === track);
}

function validateCoverage(
  runs: CompetitiveBenchmarkRun[],
  product: CompetitiveProduct,
  errors: string[],
): void {
  if (runs.length !== competitiveTasks.size * 5) {
    errors.push(`${product} must contain exactly 60 runs.`);
  }
  const unknownTasks = new Set(
    runs
      .map((run) => run.taskId)
      .filter((taskId) => !competitiveTasks.has(taskId)),
  );
  if (unknownTasks.size > 0) {
    errors.push(
      `${product} contains unknown task IDs: ${[...unknownTasks].join(", ")}.`,
    );
  }
  for (const [taskId, category] of competitiveTasks) {
    const taskRuns = runs.filter((run) => run.taskId === taskId);
    if (taskRuns.length !== 5) {
      errors.push(`${product}/${taskId} must contain exactly five runs.`);
      continue;
    }
    const repetitions = taskRuns
      .map((run) => run.repetition)
      .sort((left, right) => left - right);
    if (repetitions.join(",") !== "0,1,2,3,4") {
      errors.push(`${product}/${taskId} repetitions must be exactly 0-4.`);
    }
    if (taskRuns.some((run) => run.category !== category)) {
      errors.push(`${product}/${taskId} has the wrong category.`);
    }
  }
  if (
    runs.some(
      (run) => run.status === "not-run" || run.status === "incomparable-model",
    )
  ) {
    errors.push(`${product} contains non-comparable run statuses.`);
  }
}

function validatePairs(
  candidate: CompetitiveBenchmarkRun[],
  comparison: CompetitiveBenchmarkRun[],
  errors: string[],
): void {
  const comparisonByRun = new Map(
    comparison.map((run) => [`${run.taskId}/${run.repetition}`, run]),
  );
  for (const run of candidate) {
    const paired = comparisonByRun.get(`${run.taskId}/${run.repetition}`);
    if (
      paired &&
      (paired.seed !== run.seed || paired.fixtureSha256 !== run.fixtureSha256)
    ) {
      errors.push(
        `Candidate and comparator fixture identity differs for ${run.taskId}/${run.repetition}.`,
      );
      return;
    }
  }
}

function successRate(runs: CompetitiveBenchmarkRun[]): number {
  if (runs.length === 0) return 0;
  return (
    runs.filter((run) => run.status === "passed" && run.verifierPassed).length /
    runs.length
  );
}

function median(values: number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function invalid(errors: string[]): CompetitiveEvidenceValidation {
  return {
    valid: false,
    errors,
    claimAllowed: false,
    sotaClaimAllowed: false,
    candidateSuccessRate: 0,
    candidateMedianApprovals: Number.POSITIVE_INFINITY,
    conclusion:
      "Evidence is incomplete or non-comparable; no superiority claim is allowed.",
  };
}
