import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { hashState } from "@lhic/trace";

const studyStages = [
  "login",
  "form_filling",
  "search",
  "download",
  "test_web_flow",
  "unknown",
] as const;
const studyAdmissions = [
  "execute_fast",
  "require_confirmation",
  "defer_to_slow_path",
] as const;
const exclusionCodes = [
  "none",
  "technical_failure",
  "protocol_deviation",
] as const;
const confidenceZScores = new Map<number, number>([
  [0.9, 1.6448536269514722],
  [0.95, 1.959963984540054],
  [0.99, 2.5758293035489004],
]);
const maximumStudyRecords = 20_000;

export type LearnLoopStudyStage = (typeof studyStages)[number];
export type LearnLoopStudyAdmission = (typeof studyAdmissions)[number];
export type LearnLoopStudyExclusionCode = (typeof exclusionCodes)[number];

export interface LearnLoopStudyPlan {
  schemaVersion: "lhic-learnloop-study-plan-v1";
  studyId: string;
  protocolVersion: string;
  collectorVersion: string;
  lhicCommitSha: string;
  frozenAt: string;
  design: "paired-offline-intent-v1";
  minimumEvaluationUnits: number;
  confidenceLevel: 0.9 | 0.95 | 0.99;
  calibrationBins: number;
  requiredLanguages: string[];
  minimumEvaluationUnitsPerLanguage: number;
  thresholds: {
    minimumAccuracyGain: number;
    maximumWrongFastAdmissionUpperBound: number;
    maximumLearnedP95LatencyMs: number;
    maximumLearnedExpectedCalibrationError: number;
    significanceAlpha: number;
    minimumDistinctExpectedStages: number;
  };
}

export interface LearnLoopStudyDecisionRecord {
  predictedStage: LearnLoopStudyStage;
  confidence: number;
  admission: LearnLoopStudyAdmission;
  latencyMs: number;
}

export interface LearnLoopStudyRecord {
  schemaVersion: "lhic-learnloop-study-record-v1";
  planSha256: string;
  split: "training" | "evaluation";
  participantHash: string;
  sessionHash: string;
  taskHash: string;
  uiVariantHash: string;
  language: string;
  recordedAt: string;
  collectorVersion: string;
  consented: true;
  withdrawn: false;
  exclusionCode: LearnLoopStudyExclusionCode;
  expectedStage: LearnLoopStudyStage;
  base: LearnLoopStudyDecisionRecord;
  learned: LearnLoopStudyDecisionRecord;
}

export interface ProportionInterval {
  lower: number;
  upper: number;
}

export interface LearnLoopStudyArmMetrics {
  top1Accuracy: number;
  top1AccuracyInterval: ProportionInterval;
  fastPathCoverage: number;
  fastPathCoverageInterval: ProportionInterval;
  wrongFastAdmissionRate: number;
  wrongFastAdmissionRateInterval: ProportionInterval;
  expectedCalibrationError: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface LearnLoopStudyReport {
  schemaVersion: "lhic-learnloop-study-report-v1";
  planSha256: string;
  datasetSha256: string;
  methodology: {
    design: LearnLoopStudyPlan["design"];
    protocolVersion: string;
    lhicCommitSha: string;
    trainingRecords: number;
    evaluationRecords: number;
    includedEvaluationUnits: number;
    evaluationDispositionCounts: Record<LearnLoopStudyExclusionCode, number>;
    confidenceLevel: LearnLoopStudyPlan["confidenceLevel"];
    calibrationBins: number;
    requiredLanguages: string[];
    minimumEvaluationUnitsPerLanguage: number;
    collectorVersion: string;
    rawTaskTextCollected: false;
    rawUiTextCollected: false;
  };
  metrics: {
    base: LearnLoopStudyArmMetrics;
    learned: LearnLoopStudyArmMetrics;
    accuracyGain: number;
    pairedDiscordance: {
      baseCorrectLearnedWrong: number;
      baseWrongLearnedCorrect: number;
      twoSidedPValue: number;
      method: "exact-binomial-mcnemar";
    };
    selectiveRiskCurve: Array<{
      confidenceThreshold: number;
      baseCoverage: number;
      baseWrongFastAdmissionRate: number;
      learnedCoverage: number;
      learnedWrongFastAdmissionRate: number;
    }>;
    expectedStageCounts: Record<LearnLoopStudyStage, number>;
    languageResults: Record<
      string,
      {
        count: number;
        baseTop1Accuracy: number;
        learnedTop1Accuracy: number;
        accuracyGain: number;
      }
    >;
  };
  passCriteria: {
    minimumEvaluationUnits: boolean;
    requiredLanguageCoverage: boolean;
    expectedStageDiversity: boolean;
    accuracyGain: boolean;
    pairedSignificance: boolean;
    wrongFastAdmissionUpperBound: boolean;
    learnedCalibration: boolean;
    learnedLatencyP95: boolean;
  };
  passed: boolean;
  limitations: string[];
}

export function parseLearnLoopStudyPlan(value: unknown): LearnLoopStudyPlan {
  const plan = exactRecord(
    value,
    [
      "schemaVersion",
      "studyId",
      "protocolVersion",
      "collectorVersion",
      "lhicCommitSha",
      "frozenAt",
      "design",
      "minimumEvaluationUnits",
      "confidenceLevel",
      "calibrationBins",
      "requiredLanguages",
      "minimumEvaluationUnitsPerLanguage",
      "thresholds",
    ],
    "study plan",
  );
  if (plan.schemaVersion !== "lhic-learnloop-study-plan-v1") {
    throw new Error("Study plan schemaVersion is unsupported.");
  }
  const studyId = boundedIdentifier(plan.studyId, "studyId", 128);
  const protocolVersion = boundedIdentifier(
    plan.protocolVersion,
    "protocolVersion",
    64,
  );
  const collectorVersion = boundedIdentifier(
    plan.collectorVersion,
    "collectorVersion",
    64,
  );
  const lhicCommitSha = gitCommitSha(plan.lhicCommitSha, "lhicCommitSha");
  const frozenAt = canonicalTimestamp(plan.frozenAt, "frozenAt");
  if (plan.design !== "paired-offline-intent-v1") {
    throw new Error("Study design is unsupported.");
  }
  const minimumEvaluationUnits = boundedInteger(
    plan.minimumEvaluationUnits,
    "minimumEvaluationUnits",
    10,
    10_000,
  );
  const confidenceLevel = numericChoice(
    plan.confidenceLevel,
    confidenceZScores.keys(),
    "confidenceLevel",
  ) as LearnLoopStudyPlan["confidenceLevel"];
  const calibrationBins = boundedInteger(
    plan.calibrationBins,
    "calibrationBins",
    5,
    20,
  );
  if (!Array.isArray(plan.requiredLanguages)) {
    throw new Error("requiredLanguages must be an array.");
  }
  const requiredLanguages = plan.requiredLanguages.map((language, index) =>
    languageTag(language, `requiredLanguages[${index}]`),
  );
  if (
    requiredLanguages.length < 1 ||
    requiredLanguages.length > 16 ||
    new Set(requiredLanguages).size !== requiredLanguages.length
  ) {
    throw new Error(
      "requiredLanguages must contain 1-16 unique language tags.",
    );
  }
  const minimumEvaluationUnitsPerLanguage = boundedInteger(
    plan.minimumEvaluationUnitsPerLanguage,
    "minimumEvaluationUnitsPerLanguage",
    1,
    minimumEvaluationUnits,
  );
  const thresholds = exactRecord(
    plan.thresholds,
    [
      "minimumAccuracyGain",
      "maximumWrongFastAdmissionUpperBound",
      "maximumLearnedP95LatencyMs",
      "maximumLearnedExpectedCalibrationError",
      "significanceAlpha",
      "minimumDistinctExpectedStages",
    ],
    "study thresholds",
  );
  return {
    schemaVersion: "lhic-learnloop-study-plan-v1",
    studyId,
    protocolVersion,
    collectorVersion,
    lhicCommitSha,
    frozenAt,
    design: "paired-offline-intent-v1",
    minimumEvaluationUnits,
    confidenceLevel,
    calibrationBins,
    requiredLanguages,
    minimumEvaluationUnitsPerLanguage,
    thresholds: {
      minimumAccuracyGain: boundedNumber(
        thresholds.minimumAccuracyGain,
        "minimumAccuracyGain",
        0,
        1,
      ),
      maximumWrongFastAdmissionUpperBound: boundedNumber(
        thresholds.maximumWrongFastAdmissionUpperBound,
        "maximumWrongFastAdmissionUpperBound",
        0,
        1,
      ),
      maximumLearnedP95LatencyMs: boundedNumber(
        thresholds.maximumLearnedP95LatencyMs,
        "maximumLearnedP95LatencyMs",
        0.001,
        60_000,
      ),
      maximumLearnedExpectedCalibrationError: boundedNumber(
        thresholds.maximumLearnedExpectedCalibrationError,
        "maximumLearnedExpectedCalibrationError",
        0,
        1,
      ),
      significanceAlpha: boundedNumber(
        thresholds.significanceAlpha,
        "significanceAlpha",
        0.0001,
        0.2,
      ),
      minimumDistinctExpectedStages: boundedInteger(
        thresholds.minimumDistinctExpectedStages,
        "minimumDistinctExpectedStages",
        2,
        studyStages.length,
      ),
    },
  };
}

export function hashLearnLoopStudyPlan(plan: LearnLoopStudyPlan): string {
  return hashState(parseLearnLoopStudyPlan(plan));
}

export function parseLearnLoopStudyRecords(
  value: unknown,
): LearnLoopStudyRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Study records must be an array.");
  }
  if (value.length < 1 || value.length > maximumStudyRecords) {
    throw new Error(
      `Study records must contain 1-${maximumStudyRecords} records.`,
    );
  }
  return value.map((record, index) => parseStudyRecord(record, index));
}

export function analyzeLearnLoopStudy(
  planInput: LearnLoopStudyPlan,
  recordsInput: LearnLoopStudyRecord[],
): LearnLoopStudyReport {
  const plan = parseLearnLoopStudyPlan(planInput);
  const records = parseLearnLoopStudyRecords(recordsInput);
  const planSha256 = hashLearnLoopStudyPlan(plan);
  const frozenAtMs = Date.parse(plan.frozenAt);
  for (const [index, record] of records.entries()) {
    if (record.planSha256 !== planSha256) {
      throw new Error(`Study record ${index} is bound to a different plan.`);
    }
    if (record.collectorVersion !== plan.collectorVersion) {
      throw new Error(
        `Study record ${index} uses a different collector version.`,
      );
    }
    if (Date.parse(record.recordedAt) < frozenAtMs) {
      throw new Error(`Study record ${index} predates the frozen plan.`);
    }
  }
  assertNoDuplicateUnits(records);
  assertTrainingEvaluationSeparation(records);
  const sortedRecords = [...records].sort((left, right) =>
    recordSortKey(left).localeCompare(recordSortKey(right)),
  );
  const datasetSha256 = hashState(sortedRecords);
  const training = records.filter((record) => record.split === "training");
  const evaluation = records.filter((record) => record.split === "evaluation");
  if (training.length < 1) {
    throw new Error("Study dataset must include at least one training record.");
  }
  const included = evaluation.filter(
    (record) => record.exclusionCode === "none",
  );
  const evaluationDispositionCounts = exclusionCounts(evaluation);
  const base = armMetrics(
    included.map((record) => ({
      decision: record.base,
      expectedStage: record.expectedStage,
    })),
    plan,
  );
  const learned = armMetrics(
    included.map((record) => ({
      decision: record.learned,
      expectedStage: record.expectedStage,
    })),
    plan,
  );
  let baseCorrectLearnedWrong = 0;
  let baseWrongLearnedCorrect = 0;
  for (const record of included) {
    const baseCorrect = record.base.predictedStage === record.expectedStage;
    const learnedCorrect =
      record.learned.predictedStage === record.expectedStage;
    if (baseCorrect && !learnedCorrect) baseCorrectLearnedWrong += 1;
    if (!baseCorrect && learnedCorrect) baseWrongLearnedCorrect += 1;
  }
  const accuracyGain = learned.top1Accuracy - base.top1Accuracy;
  const pairedPValue = exactTwoSidedBinomialPValue(
    Math.min(baseCorrectLearnedWrong, baseWrongLearnedCorrect),
    baseCorrectLearnedWrong + baseWrongLearnedCorrect,
  );
  const expectedStageCounts = countStages(included);
  const languageResults = languageMetrics(included);
  const passCriteria = {
    minimumEvaluationUnits: included.length >= plan.minimumEvaluationUnits,
    requiredLanguageCoverage: plan.requiredLanguages.every(
      (language) =>
        (languageResults[language]?.count ?? 0) >=
        plan.minimumEvaluationUnitsPerLanguage,
    ),
    expectedStageDiversity:
      Object.values(expectedStageCounts).filter((count) => count > 0).length >=
      plan.thresholds.minimumDistinctExpectedStages,
    accuracyGain:
      accuracyGain >= plan.thresholds.minimumAccuracyGain &&
      learned.top1Accuracy >= base.top1Accuracy,
    pairedSignificance:
      pairedPValue <= plan.thresholds.significanceAlpha &&
      baseWrongLearnedCorrect > baseCorrectLearnedWrong,
    wrongFastAdmissionUpperBound:
      learned.wrongFastAdmissionRateInterval.upper <=
      plan.thresholds.maximumWrongFastAdmissionUpperBound,
    learnedCalibration:
      learned.expectedCalibrationError <=
      plan.thresholds.maximumLearnedExpectedCalibrationError,
    learnedLatencyP95:
      learned.latencyP95Ms <= plan.thresholds.maximumLearnedP95LatencyMs,
  };
  return {
    schemaVersion: "lhic-learnloop-study-report-v1",
    planSha256,
    datasetSha256,
    methodology: {
      design: plan.design,
      protocolVersion: plan.protocolVersion,
      lhicCommitSha: plan.lhicCommitSha,
      trainingRecords: training.length,
      evaluationRecords: evaluation.length,
      includedEvaluationUnits: included.length,
      evaluationDispositionCounts,
      confidenceLevel: plan.confidenceLevel,
      calibrationBins: plan.calibrationBins,
      requiredLanguages: [...plan.requiredLanguages],
      minimumEvaluationUnitsPerLanguage: plan.minimumEvaluationUnitsPerLanguage,
      collectorVersion: plan.collectorVersion,
      rawTaskTextCollected: false,
      rawUiTextCollected: false,
    },
    metrics: {
      base,
      learned,
      accuracyGain,
      pairedDiscordance: {
        baseCorrectLearnedWrong,
        baseWrongLearnedCorrect,
        twoSidedPValue: pairedPValue,
        method: "exact-binomial-mcnemar",
      },
      selectiveRiskCurve: selectiveRiskCurve(included),
      expectedStageCounts,
      languageResults,
    },
    passCriteria,
    passed: Object.values(passCriteria).every(Boolean),
    limitations: [
      "The paired offline design measures intent prediction and admission decisions, not real browser side effects.",
      "Results generalize only to the preregistered participants, sessions, tasks, languages, and UI variants represented in the dataset.",
      "Consent collection, participant identity proofing, compensation, and ethics review remain external operational responsibilities.",
    ],
  };
}

export async function readLearnLoopStudyPlan(
  inputFile: string,
): Promise<LearnLoopStudyPlan> {
  const text = await readFile(resolve(inputFile), "utf8");
  return parseLearnLoopStudyPlan(JSON.parse(text) as unknown);
}

export async function readLearnLoopStudyRecords(
  inputFile: string,
): Promise<LearnLoopStudyRecord[]> {
  const text = await readFile(resolve(inputFile), "utf8");
  const values = text
    .split(/\r?\n/u)
    .map((line: string) => line.trim())
    .filter(Boolean)
    .map((line: string, index: number) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Study records line ${index + 1} is not valid JSON.`);
      }
    });
  return parseLearnLoopStudyRecords(values);
}

export async function writeLearnLoopStudyReport(
  outputFile: string,
  report: LearnLoopStudyReport,
): Promise<void> {
  const resolvedOutputFile = resolve(outputFile);
  await mkdir(dirname(resolvedOutputFile), { recursive: true });
  await writeFile(resolvedOutputFile, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function parseStudyRecord(value: unknown, index: number): LearnLoopStudyRecord {
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "planSha256",
      "split",
      "participantHash",
      "sessionHash",
      "taskHash",
      "uiVariantHash",
      "language",
      "recordedAt",
      "collectorVersion",
      "consented",
      "withdrawn",
      "exclusionCode",
      "expectedStage",
      "base",
      "learned",
    ],
    `study record ${index}`,
  );
  if (record.schemaVersion !== "lhic-learnloop-study-record-v1") {
    throw new Error(`Study record ${index} schemaVersion is unsupported.`);
  }
  if (record.split !== "training" && record.split !== "evaluation") {
    throw new Error(`Study record ${index} split is invalid.`);
  }
  if (record.consented !== true) {
    throw new Error(`Study record ${index} lacks affirmative consent.`);
  }
  if (record.withdrawn !== false) {
    throw new Error(
      `Study record ${index} is withdrawn and must be deleted before analysis.`,
    );
  }
  return {
    schemaVersion: "lhic-learnloop-study-record-v1",
    planSha256: sha256(record.planSha256, `study record ${index} planSha256`),
    split: record.split,
    participantHash: sha256(
      record.participantHash,
      `study record ${index} participantHash`,
    ),
    sessionHash: sha256(
      record.sessionHash,
      `study record ${index} sessionHash`,
    ),
    taskHash: sha256(record.taskHash, `study record ${index} taskHash`),
    uiVariantHash: sha256(
      record.uiVariantHash,
      `study record ${index} uiVariantHash`,
    ),
    language: languageTag(record.language, `study record ${index} language`),
    recordedAt: canonicalTimestamp(
      record.recordedAt,
      `study record ${index} recordedAt`,
    ),
    collectorVersion: boundedIdentifier(
      record.collectorVersion,
      `study record ${index} collectorVersion`,
      64,
    ),
    consented: true,
    withdrawn: false,
    exclusionCode: stringChoice(
      record.exclusionCode,
      exclusionCodes,
      `study record ${index} exclusionCode`,
    ),
    expectedStage: stringChoice(
      record.expectedStage,
      studyStages,
      `study record ${index} expectedStage`,
    ),
    base: parseDecision(record.base, `study record ${index} base`),
    learned: parseDecision(record.learned, `study record ${index} learned`),
  };
}

function parseDecision(
  value: unknown,
  name: string,
): LearnLoopStudyDecisionRecord {
  const decision = exactRecord(
    value,
    ["predictedStage", "confidence", "admission", "latencyMs"],
    name,
  );
  return {
    predictedStage: stringChoice(
      decision.predictedStage,
      studyStages,
      `${name} predictedStage`,
    ),
    confidence: boundedNumber(decision.confidence, `${name} confidence`, 0, 1),
    admission: stringChoice(
      decision.admission,
      studyAdmissions,
      `${name} admission`,
    ),
    latencyMs: boundedNumber(
      decision.latencyMs,
      `${name} latencyMs`,
      0,
      60_000,
    ),
  };
}

function armMetrics(
  cases: Array<{
    decision: LearnLoopStudyDecisionRecord;
    expectedStage: LearnLoopStudyStage;
  }>,
  plan: LearnLoopStudyPlan,
): LearnLoopStudyArmMetrics {
  const correct = cases.filter(
    ({ decision, expectedStage }) => decision.predictedStage === expectedStage,
  ).length;
  const fast = cases.filter(
    ({ decision }) => decision.admission === "execute_fast",
  );
  const wrongFast = fast.filter(
    ({ decision, expectedStage }) => decision.predictedStage !== expectedStage,
  ).length;
  const latencies = cases.map(({ decision }) => decision.latencyMs);
  return {
    top1Accuracy: ratio(correct, cases.length),
    top1AccuracyInterval: wilsonInterval(
      correct,
      cases.length,
      plan.confidenceLevel,
    ),
    fastPathCoverage: ratio(fast.length, cases.length),
    fastPathCoverageInterval: wilsonInterval(
      fast.length,
      cases.length,
      plan.confidenceLevel,
    ),
    wrongFastAdmissionRate: ratio(wrongFast, fast.length),
    wrongFastAdmissionRateInterval: wilsonInterval(
      wrongFast,
      fast.length,
      plan.confidenceLevel,
    ),
    expectedCalibrationError: expectedCalibrationError(
      cases,
      plan.calibrationBins,
    ),
    latencyP50Ms: percentile(latencies, 0.5),
    latencyP95Ms: percentile(latencies, 0.95),
  };
}

function expectedCalibrationError(
  cases: Array<{
    decision: LearnLoopStudyDecisionRecord;
    expectedStage: LearnLoopStudyStage;
  }>,
  bins: number,
): number {
  if (cases.length === 0) return 0;
  let error = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const lower = bin / bins;
    const upper = (bin + 1) / bins;
    const members = cases.filter(({ decision }) =>
      bin === bins - 1
        ? decision.confidence >= lower && decision.confidence <= upper
        : decision.confidence >= lower && decision.confidence < upper,
    );
    if (members.length === 0) continue;
    const accuracy = ratio(
      members.filter(
        ({ decision, expectedStage }) =>
          decision.predictedStage === expectedStage,
      ).length,
      members.length,
    );
    const confidence =
      members.reduce((sum, { decision }) => sum + decision.confidence, 0) /
      members.length;
    error += (members.length / cases.length) * Math.abs(accuracy - confidence);
  }
  return error;
}

function selectiveRiskCurve(
  records: LearnLoopStudyRecord[],
): LearnLoopStudyReport["metrics"]["selectiveRiskCurve"] {
  return [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((confidenceThreshold) => {
    const base = selectiveRisk(records, "base", confidenceThreshold);
    const learned = selectiveRisk(records, "learned", confidenceThreshold);
    return {
      confidenceThreshold,
      baseCoverage: base.coverage,
      baseWrongFastAdmissionRate: base.wrongFastAdmissionRate,
      learnedCoverage: learned.coverage,
      learnedWrongFastAdmissionRate: learned.wrongFastAdmissionRate,
    };
  });
}

function selectiveRisk(
  records: LearnLoopStudyRecord[],
  arm: "base" | "learned",
  threshold: number,
): { coverage: number; wrongFastAdmissionRate: number } {
  const admitted = records.filter(
    (record) =>
      record[arm].admission === "execute_fast" &&
      record[arm].confidence >= threshold,
  );
  const wrong = admitted.filter(
    (record) => record[arm].predictedStage !== record.expectedStage,
  ).length;
  return {
    coverage: ratio(admitted.length, records.length),
    wrongFastAdmissionRate: ratio(wrong, admitted.length),
  };
}

function languageMetrics(
  records: LearnLoopStudyRecord[],
): LearnLoopStudyReport["metrics"]["languageResults"] {
  const grouped = new Map<string, LearnLoopStudyRecord[]>();
  for (const record of records) {
    const current = grouped.get(record.language) ?? [];
    current.push(record);
    grouped.set(record.language, current);
  }
  return Object.fromEntries(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([language, members]) => {
        const baseCorrect = members.filter(
          (record) => record.base.predictedStage === record.expectedStage,
        ).length;
        const learnedCorrect = members.filter(
          (record) => record.learned.predictedStage === record.expectedStage,
        ).length;
        const baseTop1Accuracy = ratio(baseCorrect, members.length);
        const learnedTop1Accuracy = ratio(learnedCorrect, members.length);
        return [
          language,
          {
            count: members.length,
            baseTop1Accuracy,
            learnedTop1Accuracy,
            accuracyGain: learnedTop1Accuracy - baseTop1Accuracy,
          },
        ];
      }),
  );
}

function countStages(
  records: LearnLoopStudyRecord[],
): Record<LearnLoopStudyStage, number> {
  const counts = Object.fromEntries(
    studyStages.map((stage) => [stage, 0]),
  ) as Record<LearnLoopStudyStage, number>;
  for (const record of records) counts[record.expectedStage] += 1;
  return counts;
}

function exclusionCounts(
  records: LearnLoopStudyRecord[],
): Record<LearnLoopStudyExclusionCode, number> {
  const counts = Object.fromEntries(
    exclusionCodes.map((code) => [code, 0]),
  ) as Record<LearnLoopStudyExclusionCode, number>;
  for (const record of records) counts[record.exclusionCode] += 1;
  return counts;
}

function assertNoDuplicateUnits(records: LearnLoopStudyRecord[]): void {
  const seen = new Set<string>();
  for (const record of records) {
    const key = recordSortKey(record);
    if (seen.has(key)) {
      throw new Error("Study dataset contains a duplicate evaluation unit.");
    }
    seen.add(key);
  }
}

function assertTrainingEvaluationSeparation(
  records: LearnLoopStudyRecord[],
): void {
  const training = records.filter((record) => record.split === "training");
  const evaluation = records.filter((record) => record.split === "evaluation");
  for (const [name, selector] of [
    ["participant", (record: LearnLoopStudyRecord) => record.participantHash],
    ["session", (record: LearnLoopStudyRecord) => record.sessionHash],
    ["task", (record: LearnLoopStudyRecord) => record.taskHash],
    ["UI variant", (record: LearnLoopStudyRecord) => record.uiVariantHash],
  ] as const) {
    const trainingValues = new Set(training.map(selector));
    if (evaluation.some((record) => trainingValues.has(selector(record)))) {
      throw new Error(`Training/evaluation ${name} leakage was detected.`);
    }
  }
}

function recordSortKey(record: LearnLoopStudyRecord): string {
  return [
    record.split,
    record.participantHash,
    record.sessionHash,
    record.taskHash,
    record.uiVariantHash,
  ].join(":");
}

function wilsonInterval(
  successes: number,
  trials: number,
  confidenceLevel: LearnLoopStudyPlan["confidenceLevel"],
): ProportionInterval {
  if (trials === 0) return { lower: 0, upper: 1 };
  const z = confidenceZScores.get(confidenceLevel);
  if (!z) throw new Error("Unsupported confidence level.");
  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / trials +
        zSquared / (4 * trials * trials),
    );
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function exactTwoSidedBinomialPValue(
  smallerDiscordantCount: number,
  discordantCount: number,
): number {
  if (discordantCount === 0) return 1;
  const logs: number[] = [];
  for (let count = 0; count <= smallerDiscordantCount; count += 1) {
    logs.push(
      logBinomialCoefficient(discordantCount, count) -
        discordantCount * Math.log(2),
    );
  }
  const maximum = Math.max(...logs);
  const cumulative =
    Math.exp(maximum) *
    logs.reduce((sum, value) => sum + Math.exp(value - maximum), 0);
  return Math.min(1, 2 * cumulative);
}

function logBinomialCoefficient(n: number, k: number): number {
  const selected = Math.min(k, n - k);
  let value = 0;
  for (let index = 1; index <= selected; index += 1) {
    value += Math.log(n - selected + index) - Math.log(index);
  }
  return value;
}

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1),
  );
  return sorted[index] ?? 0;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new Error(`${name} contains unexpected or missing fields.`);
  }
  return record;
}

function boundedIdentifier(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9._:-]+$/u.test(value) ||
    value.length < 1 ||
    value.length > maximumLength
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is invalid.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp.`);
  }
  return value;
}

function languageTag(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value) ||
    value.length > 35
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function gitCommitSha(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    (!/^[a-f0-9]{40}$/u.test(value) && !/^[a-f0-9]{64}$/u.test(value))
  ) {
    throw new Error(`${name} must be a full lowercase Git commit digest.`);
  }
  return value;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function numericChoice(
  value: unknown,
  choices: Iterable<number>,
  name: string,
): number {
  if (typeof value !== "number" || ![...choices].includes(value)) {
    throw new Error(`${name} is unsupported.`);
  }
  return value;
}

function stringChoice<const Values extends readonly string[]>(
  value: unknown,
  choices: Values,
  name: string,
): Values[number] {
  if (
    typeof value !== "string" ||
    !(choices as readonly string[]).includes(value)
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value as Values[number];
}
