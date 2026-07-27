import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { hashState } from "@lhic/trace";

import {
  hashLearnLoopStudyPlan,
  parseLearnLoopStudyPlan,
  parseLearnLoopStudyRecords,
  type LearnLoopStudyPlan,
  type LearnLoopStudyRecord,
  type LearnLoopStudyStage,
} from "./learnloop-study.js";

const studyStages = [
  "login",
  "form_filling",
  "search",
  "download",
  "test_web_flow",
  "unknown",
] as const satisfies readonly LearnLoopStudyStage[];
const adjudicationReasons = [
  "evidence_review",
  "third_rater_consensus",
  "insufficient_context",
] as const;
const maximumStudyUnits = 20_000;
const maximumAnnotations = maximumStudyUnits * 2;

export type LearnLoopStudyBlindUnit = Omit<
  LearnLoopStudyRecord,
  "expectedStage"
>;
export type LearnLoopStudyAdjudicationReason =
  (typeof adjudicationReasons)[number];

export interface LearnLoopStudyAnnotationRecord {
  schemaVersion: "lhic-learnloop-study-annotation-v1";
  planSha256: string;
  unitHash: string;
  annotatorHash: string;
  expectedStage: LearnLoopStudyStage;
  recordedAt: string;
  blindedToArm: true;
}

export interface LearnLoopStudyAdjudicationRecord {
  schemaVersion: "lhic-learnloop-study-adjudication-v1";
  planSha256: string;
  unitHash: string;
  adjudicatorHash: string;
  finalStage: LearnLoopStudyStage;
  reasonCode: LearnLoopStudyAdjudicationReason;
  recordedAt: string;
  blindedToArm: true;
}

export interface LearnLoopStudyLabelingReport {
  schemaVersion: "lhic-learnloop-study-labeling-report-v1";
  planSha256: string;
  unitDatasetSha256: string;
  annotationDatasetSha256: string;
  adjudicationDatasetSha256: string;
  finalizedRecordsSha256: string;
  methodology: {
    labelsPerUnit: 2;
    distinctAnnotatorsRequired: true;
    blindedToArm: true;
    adjudicationRequiredForDisagreement: true;
    adjudicatorMustBeIndependent: true;
  };
  counts: {
    units: number;
    trainingUnits: number;
    evaluationUnits: number;
    annotations: number;
    adjudications: number;
    agreedUnits: number;
    disagreedUnits: number;
  };
  agreement: {
    rawAgreement: number;
    fleissKappa: number;
    method: "fleiss-kappa-nominal";
  };
  annotationStageCounts: Record<LearnLoopStudyStage, number>;
  goldStageCounts: Record<LearnLoopStudyStage, number>;
  annotatorUnitCounts: Record<string, number>;
  adjudicatorUnitCounts: Record<string, number>;
  limitations: string[];
}

export interface FinalizedLearnLoopStudyLabels {
  records: LearnLoopStudyRecord[];
  report: LearnLoopStudyLabelingReport;
}

export function parseLearnLoopStudyBlindUnits(
  value: unknown,
): LearnLoopStudyBlindUnit[] {
  if (!Array.isArray(value)) {
    throw new Error("Study blind units must be an array.");
  }
  if (value.length < 1 || value.length > maximumStudyUnits) {
    throw new Error(
      `Study blind units must contain 1-${maximumStudyUnits} units.`,
    );
  }
  return value.map((unit, index) => parseBlindUnit(unit, index));
}

export function parseLearnLoopStudyAnnotations(
  value: unknown,
): LearnLoopStudyAnnotationRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Study annotations must be an array.");
  }
  if (value.length < 1 || value.length > maximumAnnotations) {
    throw new Error(
      `Study annotations must contain 1-${maximumAnnotations} records.`,
    );
  }
  return value.map((annotation, index) => parseAnnotation(annotation, index));
}

export function parseLearnLoopStudyAdjudications(
  value: unknown,
): LearnLoopStudyAdjudicationRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("Study adjudications must be an array.");
  }
  if (value.length > maximumStudyUnits) {
    throw new Error(
      `Study adjudications must contain 0-${maximumStudyUnits} records.`,
    );
  }
  return value.map((adjudication, index) =>
    parseAdjudication(adjudication, index),
  );
}

export function hashLearnLoopStudyBlindUnit(
  unitInput: LearnLoopStudyBlindUnit,
): string {
  return hashState(parseLearnLoopStudyBlindUnits([unitInput])[0]!);
}

export function finalizeLearnLoopStudyLabels(
  planInput: LearnLoopStudyPlan,
  unitsInput: LearnLoopStudyBlindUnit[],
  annotationsInput: LearnLoopStudyAnnotationRecord[],
  adjudicationsInput: LearnLoopStudyAdjudicationRecord[],
): FinalizedLearnLoopStudyLabels {
  const plan = parseLearnLoopStudyPlan(planInput);
  const units = parseLearnLoopStudyBlindUnits(unitsInput);
  const annotations = parseLearnLoopStudyAnnotations(annotationsInput);
  const adjudications = parseLearnLoopStudyAdjudications(adjudicationsInput);
  const planSha256 = hashLearnLoopStudyPlan(plan);
  const frozenAtMs = Date.parse(plan.frozenAt);

  const unitsByHash = new Map<string, LearnLoopStudyBlindUnit>();
  const identityKeys = new Set<string>();
  for (const [index, unit] of units.entries()) {
    if (unit.planSha256 !== planSha256) {
      throw new Error(
        `Study blind unit ${index} is bound to a different plan.`,
      );
    }
    if (unit.collectorVersion !== plan.collectorVersion) {
      throw new Error(
        `Study blind unit ${index} uses a different collector version.`,
      );
    }
    if (Date.parse(unit.recordedAt) < frozenAtMs) {
      throw new Error(`Study blind unit ${index} predates the frozen plan.`);
    }
    const unitHash = hashState(unit);
    if (unitsByHash.has(unitHash)) {
      throw new Error(`Study blind unit ${index} is duplicated.`);
    }
    const identityKey = studyIdentityKey(unit);
    if (identityKeys.has(identityKey)) {
      throw new Error(
        `Study blind unit ${index} duplicates a participant/session/task/UI unit.`,
      );
    }
    unitsByHash.set(unitHash, unit);
    identityKeys.add(identityKey);
  }
  assertTrainingEvaluationSeparation(units);

  const annotationsByUnit = groupByUnitHash(annotations);
  const adjudicationsByUnit = groupByUnitHash(adjudications);
  assertNoOrphanRows(annotationsByUnit.keys(), unitsByHash, "Study annotation");
  assertNoOrphanRows(
    adjudicationsByUnit.keys(),
    unitsByHash,
    "Study adjudication",
  );

  const finalized: Array<{
    unitHash: string;
    record: LearnLoopStudyRecord;
    annotationStages: [LearnLoopStudyStage, LearnLoopStudyStage];
  }> = [];
  const annotatorCounts = new Map<string, number>();
  const adjudicatorCounts = new Map<string, number>();
  let agreedUnits = 0;
  let disagreedUnits = 0;

  for (const [unitHash, unit] of unitsByHash) {
    const unitAnnotations = annotationsByUnit.get(unitHash) ?? [];
    if (unitAnnotations.length !== 2) {
      throw new Error(
        `Study unit ${unitHash} must have exactly two blinded annotations.`,
      );
    }
    const [first, second] = [...unitAnnotations].sort((left, right) =>
      left.annotatorHash.localeCompare(right.annotatorHash),
    ) as [LearnLoopStudyAnnotationRecord, LearnLoopStudyAnnotationRecord];
    if (first.annotatorHash === second.annotatorHash) {
      throw new Error(
        `Study unit ${unitHash} annotations must come from distinct annotators.`,
      );
    }
    for (const annotation of [first, second]) {
      assertAnnotationBinding(
        annotation,
        unit,
        planSha256,
        frozenAtMs,
        annotatorCounts,
      );
    }

    const unitAdjudications = adjudicationsByUnit.get(unitHash) ?? [];
    let expectedStage: LearnLoopStudyStage;
    if (first.expectedStage === second.expectedStage) {
      agreedUnits += 1;
      if (unitAdjudications.length !== 0) {
        throw new Error(
          `Study unit ${unitHash} agrees and must not have an adjudication.`,
        );
      }
      expectedStage = first.expectedStage;
    } else {
      disagreedUnits += 1;
      if (unitAdjudications.length !== 1) {
        throw new Error(
          `Study unit ${unitHash} disagrees and requires exactly one adjudication.`,
        );
      }
      const adjudication = unitAdjudications[0]!;
      assertAdjudicationBinding(
        adjudication,
        unit,
        first,
        second,
        planSha256,
        frozenAtMs,
        adjudicatorCounts,
      );
      expectedStage = adjudication.finalStage;
    }

    finalized.push({
      unitHash,
      record: {
        ...unit,
        expectedStage,
      },
      annotationStages: [first.expectedStage, second.expectedStage],
    });
  }

  const records = parseLearnLoopStudyRecords(
    finalized
      .sort((left, right) => left.unitHash.localeCompare(right.unitHash))
      .map(({ record }) => record),
  );
  const annotationStageCounts = countStages(
    finalized.flatMap(({ annotationStages }) => annotationStages),
  );
  const goldStageCounts = countStages(
    finalized.map(({ record }) => record.expectedStage),
  );
  const rawAgreement = agreedUnits / units.length;
  const report: LearnLoopStudyLabelingReport = {
    schemaVersion: "lhic-learnloop-study-labeling-report-v1",
    planSha256,
    unitDatasetSha256: hashState(
      [...unitsByHash.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, unit]) => unit),
    ),
    annotationDatasetSha256: hashState(
      [...annotations].sort((left, right) =>
        annotationSortKey(left).localeCompare(annotationSortKey(right)),
      ),
    ),
    adjudicationDatasetSha256: hashState(
      [...adjudications].sort((left, right) =>
        adjudicationSortKey(left).localeCompare(adjudicationSortKey(right)),
      ),
    ),
    finalizedRecordsSha256: hashState(records),
    methodology: {
      labelsPerUnit: 2,
      distinctAnnotatorsRequired: true,
      blindedToArm: true,
      adjudicationRequiredForDisagreement: true,
      adjudicatorMustBeIndependent: true,
    },
    counts: {
      units: units.length,
      trainingUnits: units.filter((unit) => unit.split === "training").length,
      evaluationUnits: units.filter((unit) => unit.split === "evaluation")
        .length,
      annotations: annotations.length,
      adjudications: adjudications.length,
      agreedUnits,
      disagreedUnits,
    },
    agreement: {
      rawAgreement,
      fleissKappa: fleissKappa(
        finalized.map(({ annotationStages }) => annotationStages),
      ),
      method: "fleiss-kappa-nominal",
    },
    annotationStageCounts,
    goldStageCounts,
    annotatorUnitCounts: sortedCountRecord(annotatorCounts),
    adjudicatorUnitCounts: sortedCountRecord(adjudicatorCounts),
    limitations: [
      "Agreement metrics measure label consistency, not label validity or model performance.",
      "Blinding, annotator training, compensation, consent, and adjudicator independence remain operational responsibilities outside this repository.",
      "A high kappa can coexist with a shared systematic labeling error; the gold-label rubric and audit sample must still be independently reviewed.",
    ],
  };
  return { records, report };
}

export async function readLearnLoopStudyBlindUnits(
  inputFile: string,
): Promise<LearnLoopStudyBlindUnit[]> {
  return parseLearnLoopStudyBlindUnits(
    await readJsonLines(inputFile, "Study blind units"),
  );
}

export async function readLearnLoopStudyAnnotations(
  inputFile: string,
): Promise<LearnLoopStudyAnnotationRecord[]> {
  return parseLearnLoopStudyAnnotations(
    await readJsonLines(inputFile, "Study annotations"),
  );
}

export async function readLearnLoopStudyAdjudications(
  inputFile: string,
): Promise<LearnLoopStudyAdjudicationRecord[]> {
  return parseLearnLoopStudyAdjudications(
    await readJsonLines(inputFile, "Study adjudications"),
  );
}

export async function writeFinalizedLearnLoopStudyLabels(
  recordsOutputFile: string,
  reportOutputFile: string,
  finalized: FinalizedLearnLoopStudyLabels,
): Promise<void> {
  const resolvedRecordsFile = resolve(recordsOutputFile);
  const resolvedReportFile = resolve(reportOutputFile);
  if (resolvedRecordsFile === resolvedReportFile) {
    throw new Error(
      "Finalized records and labeling report need different paths.",
    );
  }
  await Promise.all([
    mkdir(dirname(resolvedRecordsFile), { recursive: true }),
    mkdir(dirname(resolvedReportFile), { recursive: true }),
  ]);
  let recordsWritten = false;
  try {
    await writeFile(
      resolvedRecordsFile,
      `${finalized.records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    recordsWritten = true;
    await writeFile(
      resolvedReportFile,
      `${JSON.stringify(finalized.report, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  } catch (error) {
    if (recordsWritten) {
      await rm(resolvedRecordsFile, { force: true });
    }
    throw error;
  }
}

function parseBlindUnit(
  value: unknown,
  index: number,
): LearnLoopStudyBlindUnit {
  const unit = exactRecord(
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
      "base",
      "learned",
    ],
    `study blind unit ${index}`,
  );
  const parsed = parseLearnLoopStudyRecords([
    {
      ...unit,
      expectedStage: "unknown",
    },
  ])[0]!;
  const { expectedStage, ...blindUnit } = parsed;
  void expectedStage;
  return blindUnit;
}

function parseAnnotation(
  value: unknown,
  index: number,
): LearnLoopStudyAnnotationRecord {
  const annotation = exactRecord(
    value,
    [
      "schemaVersion",
      "planSha256",
      "unitHash",
      "annotatorHash",
      "expectedStage",
      "recordedAt",
      "blindedToArm",
    ],
    `study annotation ${index}`,
  );
  if (annotation.schemaVersion !== "lhic-learnloop-study-annotation-v1") {
    throw new Error(`Study annotation ${index} schemaVersion is unsupported.`);
  }
  if (annotation.blindedToArm !== true) {
    throw new Error(
      `Study annotation ${index} is not blinded to the model arm.`,
    );
  }
  return {
    schemaVersion: "lhic-learnloop-study-annotation-v1",
    planSha256: sha256(
      annotation.planSha256,
      `study annotation ${index} planSha256`,
    ),
    unitHash: sha256(annotation.unitHash, `study annotation ${index} unitHash`),
    annotatorHash: sha256(
      annotation.annotatorHash,
      `study annotation ${index} annotatorHash`,
    ),
    expectedStage: stage(
      annotation.expectedStage,
      `study annotation ${index} expectedStage`,
    ),
    recordedAt: canonicalTimestamp(
      annotation.recordedAt,
      `study annotation ${index} recordedAt`,
    ),
    blindedToArm: true,
  };
}

function parseAdjudication(
  value: unknown,
  index: number,
): LearnLoopStudyAdjudicationRecord {
  const adjudication = exactRecord(
    value,
    [
      "schemaVersion",
      "planSha256",
      "unitHash",
      "adjudicatorHash",
      "finalStage",
      "reasonCode",
      "recordedAt",
      "blindedToArm",
    ],
    `study adjudication ${index}`,
  );
  if (adjudication.schemaVersion !== "lhic-learnloop-study-adjudication-v1") {
    throw new Error(
      `Study adjudication ${index} schemaVersion is unsupported.`,
    );
  }
  if (adjudication.blindedToArm !== true) {
    throw new Error(
      `Study adjudication ${index} is not blinded to the model arm.`,
    );
  }
  return {
    schemaVersion: "lhic-learnloop-study-adjudication-v1",
    planSha256: sha256(
      adjudication.planSha256,
      `study adjudication ${index} planSha256`,
    ),
    unitHash: sha256(
      adjudication.unitHash,
      `study adjudication ${index} unitHash`,
    ),
    adjudicatorHash: sha256(
      adjudication.adjudicatorHash,
      `study adjudication ${index} adjudicatorHash`,
    ),
    finalStage: stage(
      adjudication.finalStage,
      `study adjudication ${index} finalStage`,
    ),
    reasonCode: stringChoice(
      adjudication.reasonCode,
      adjudicationReasons,
      `study adjudication ${index} reasonCode`,
    ),
    recordedAt: canonicalTimestamp(
      adjudication.recordedAt,
      `study adjudication ${index} recordedAt`,
    ),
    blindedToArm: true,
  };
}

function assertAnnotationBinding(
  annotation: LearnLoopStudyAnnotationRecord,
  unit: LearnLoopStudyBlindUnit,
  planSha256: string,
  frozenAtMs: number,
  counts: Map<string, number>,
): void {
  if (annotation.planSha256 !== planSha256) {
    throw new Error(
      `Study annotation ${annotation.unitHash} uses another plan.`,
    );
  }
  if (annotation.unitHash !== hashState(unit)) {
    throw new Error(
      `Study annotation ${annotation.unitHash} uses another unit.`,
    );
  }
  if (
    Date.parse(annotation.recordedAt) < frozenAtMs ||
    Date.parse(annotation.recordedAt) < Date.parse(unit.recordedAt)
  ) {
    throw new Error(
      `Study annotation ${annotation.unitHash} predates its frozen unit.`,
    );
  }
  counts.set(
    annotation.annotatorHash,
    (counts.get(annotation.annotatorHash) ?? 0) + 1,
  );
}

function assertAdjudicationBinding(
  adjudication: LearnLoopStudyAdjudicationRecord,
  unit: LearnLoopStudyBlindUnit,
  first: LearnLoopStudyAnnotationRecord,
  second: LearnLoopStudyAnnotationRecord,
  planSha256: string,
  frozenAtMs: number,
  counts: Map<string, number>,
): void {
  if (adjudication.planSha256 !== planSha256) {
    throw new Error(
      `Study adjudication ${adjudication.unitHash} uses another plan.`,
    );
  }
  if (adjudication.unitHash !== hashState(unit)) {
    throw new Error(
      `Study adjudication ${adjudication.unitHash} uses another unit.`,
    );
  }
  if (
    adjudication.adjudicatorHash === first.annotatorHash ||
    adjudication.adjudicatorHash === second.annotatorHash
  ) {
    throw new Error(
      `Study unit ${adjudication.unitHash} adjudicator must be independent.`,
    );
  }
  const recordedAtMs = Date.parse(adjudication.recordedAt);
  if (
    recordedAtMs < frozenAtMs ||
    recordedAtMs < Date.parse(first.recordedAt) ||
    recordedAtMs < Date.parse(second.recordedAt)
  ) {
    throw new Error(
      `Study adjudication ${adjudication.unitHash} predates its annotations.`,
    );
  }
  counts.set(
    adjudication.adjudicatorHash,
    (counts.get(adjudication.adjudicatorHash) ?? 0) + 1,
  );
}

function assertTrainingEvaluationSeparation(
  units: LearnLoopStudyBlindUnit[],
): void {
  for (const field of [
    "participantHash",
    "sessionHash",
    "taskHash",
    "uiVariantHash",
  ] as const) {
    const training = new Set(
      units
        .filter((unit) => unit.split === "training")
        .map((unit) => unit[field]),
    );
    const overlap = units.find(
      (unit) => unit.split === "evaluation" && training.has(unit[field]),
    );
    if (overlap) {
      throw new Error(`Training and evaluation overlap on ${field}.`);
    }
  }
}

function assertNoOrphanRows<T>(
  unitHashes: IterableIterator<string>,
  unitsByHash: Map<string, T>,
  name: string,
): void {
  for (const unitHash of unitHashes) {
    if (!unitsByHash.has(unitHash)) {
      throw new Error(`${name} references an unknown unit ${unitHash}.`);
    }
  }
}

function groupByUnitHash<T extends { unitHash: string }>(
  rows: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(row.unitHash) ?? [];
    existing.push(row);
    grouped.set(row.unitHash, existing);
  }
  return grouped;
}

function fleissKappa(
  ratings: Array<[LearnLoopStudyStage, LearnLoopStudyStage]>,
): number {
  const totalRatings = ratings.length * 2;
  const stageTotals = countStages(ratings.flat());
  const observedAgreement =
    ratings.filter(([first, second]) => first === second).length /
    ratings.length;
  const expectedAgreement = Object.values(stageTotals).reduce(
    (sum, count) => sum + (count / totalRatings) ** 2,
    0,
  );
  if (expectedAgreement === 1) return observedAgreement === 1 ? 1 : 0;
  return (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
}

function countStages(
  stages: LearnLoopStudyStage[],
): Record<LearnLoopStudyStage, number> {
  const counts: Record<LearnLoopStudyStage, number> = {
    login: 0,
    form_filling: 0,
    search: 0,
    download: 0,
    test_web_flow: 0,
    unknown: 0,
  };
  for (const currentStage of stages) counts[currentStage] += 1;
  return counts;
}

function sortedCountRecord(
  counts: Map<string, number>,
): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function readJsonLines(
  inputFile: string,
  name: string,
): Promise<unknown[]> {
  const text = await readFile(resolve(inputFile), "utf8");
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${name} line ${index + 1} is not valid JSON.`);
      }
    });
}

function studyIdentityKey(unit: LearnLoopStudyBlindUnit): string {
  return [
    unit.split,
    unit.participantHash,
    unit.sessionHash,
    unit.taskHash,
    unit.uiVariantHash,
  ].join(":");
}

function annotationSortKey(annotation: LearnLoopStudyAnnotationRecord): string {
  return `${annotation.unitHash}:${annotation.annotatorHash}`;
}

function adjudicationSortKey(
  adjudication: LearnLoopStudyAdjudicationRecord,
): string {
  return `${adjudication.unitHash}:${adjudication.adjudicatorHash}`;
}

function stage(value: unknown, name: string): LearnLoopStudyStage {
  return stringChoice(value, studyStages, name);
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${name} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function canonicalTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp.`);
  }
  const canonical = new Date(value).toISOString();
  if (canonical !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp.`);
  }
  return canonical;
}

function stringChoice<const T extends readonly string[]>(
  value: unknown,
  choices: T,
  name: string,
): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) {
    throw new Error(`${name} is unsupported.`);
  }
  return value as T[number];
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${name} has missing or unexpected fields.`);
  }
  return record;
}
