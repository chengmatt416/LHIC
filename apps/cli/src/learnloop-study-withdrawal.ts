import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { hashState } from "@lhic/trace";

import {
  hashLearnLoopStudyBlindUnit,
  parseLearnLoopStudyAdjudications,
  parseLearnLoopStudyAnnotations,
  parseLearnLoopStudyBlindUnits,
  type LearnLoopStudyAdjudicationRecord,
  type LearnLoopStudyAnnotationRecord,
  type LearnLoopStudyBlindUnit,
} from "./learnloop-study-labeling.js";

export interface LearnLoopStudyWithdrawalReceipt {
  schemaVersion: "lhic-learnloop-study-withdrawal-receipt-v1";
  planSha256: string;
  withdrawalSubjectCommitment: string;
  withdrawnAt: string;
  input: {
    units: number;
    annotations: number;
    adjudications: number;
    unitDatasetSha256: string;
    annotationDatasetSha256: string;
    adjudicationDatasetSha256: string;
  };
  output: {
    units: number;
    annotations: number;
    adjudications: number;
    unitDatasetSha256: string;
    annotationDatasetSha256: string;
    adjudicationDatasetSha256: string;
  };
  removed: {
    units: number;
    annotations: number;
    adjudications: number;
    unitSetSha256: string;
  };
  invalidation: {
    priorFinalizedRecordsMustBeDeleted: true;
    priorLabelingReportsMustBeDeleted: true;
    priorAnalysisReportsMustBeDeleted: true;
    finalizationAndAnalysisMustBeRerun: true;
  };
}

export interface RedactedLearnLoopStudyData {
  units: LearnLoopStudyBlindUnit[];
  annotations: LearnLoopStudyAnnotationRecord[];
  adjudications: LearnLoopStudyAdjudicationRecord[];
  receipt: LearnLoopStudyWithdrawalReceipt;
}

export function redactLearnLoopStudyParticipant(
  unitsInput: LearnLoopStudyBlindUnit[],
  annotationsInput: LearnLoopStudyAnnotationRecord[],
  adjudicationsInput: LearnLoopStudyAdjudicationRecord[],
  participantHashInput: string,
  withdrawnAtInput: string,
): RedactedLearnLoopStudyData {
  const units = parseLearnLoopStudyBlindUnits(unitsInput);
  const annotations =
    annotationsInput.length === 0
      ? []
      : parseLearnLoopStudyAnnotations(annotationsInput);
  const adjudications = parseLearnLoopStudyAdjudications(adjudicationsInput);
  const participantHash = sha256(participantHashInput, "participantHash");
  const withdrawnAt = canonicalTimestamp(withdrawnAtInput, "withdrawnAt");

  const unitRows = units.map((unit) => ({
    unit,
    unitHash: hashLearnLoopStudyBlindUnit(unit),
  }));
  const unitHashes = new Set<string>();
  const planHashes = new Set<string>();
  for (const { unitHash, unit } of unitRows) {
    if (unitHashes.has(unitHash)) {
      throw new Error(`Study withdrawal input duplicates unit ${unitHash}.`);
    }
    unitHashes.add(unitHash);
    planHashes.add(unit.planSha256);
  }
  if (planHashes.size !== 1) {
    throw new Error("Study withdrawal input must use exactly one frozen plan.");
  }
  const planSha256 = [...planHashes][0]!;
  const latestSourceRecordedAtMs = Math.max(
    ...units.map((unit) => Date.parse(unit.recordedAt)),
    ...annotations.map((annotation) => Date.parse(annotation.recordedAt)),
    ...adjudications.map((adjudication) => Date.parse(adjudication.recordedAt)),
  );
  if (Date.parse(withdrawnAt) < latestSourceRecordedAtMs) {
    throw new Error("Study withdrawal timestamp predates a source record.");
  }
  assertRowsBoundToKnownUnits(
    annotations,
    unitHashes,
    planSha256,
    "Study annotation",
  );
  assertRowsBoundToKnownUnits(
    adjudications,
    unitHashes,
    planSha256,
    "Study adjudication",
  );
  assertUniqueRows(
    annotations.map((annotation) => annotationSortKey(annotation)),
    "Study annotation",
  );
  assertUniqueRows(
    adjudications.map((adjudication) => adjudicationSortKey(adjudication)),
    "Study adjudication",
  );

  const removedUnitHashes = unitRows
    .filter(({ unit }) => unit.participantHash === participantHash)
    .map(({ unitHash }) => unitHash)
    .sort();
  if (removedUnitHashes.length === 0) {
    throw new Error("Study withdrawal participant was not found.");
  }
  const removedUnitHashSet = new Set(removedUnitHashes);
  const redactedUnits = unitRows
    .filter(({ unitHash }) => !removedUnitHashSet.has(unitHash))
    .sort((left, right) => left.unitHash.localeCompare(right.unitHash))
    .map(({ unit }) => unit);
  const redactedAnnotations = annotations
    .filter((annotation) => !removedUnitHashSet.has(annotation.unitHash))
    .sort((left, right) =>
      annotationSortKey(left).localeCompare(annotationSortKey(right)),
    );
  const redactedAdjudications = adjudications
    .filter((adjudication) => !removedUnitHashSet.has(adjudication.unitHash))
    .sort((left, right) =>
      adjudicationSortKey(left).localeCompare(adjudicationSortKey(right)),
    );

  const receipt: LearnLoopStudyWithdrawalReceipt = {
    schemaVersion: "lhic-learnloop-study-withdrawal-receipt-v1",
    planSha256,
    withdrawalSubjectCommitment: hashState({
      planSha256,
      participantHash,
      withdrawnAt,
    }),
    withdrawnAt,
    input: {
      units: units.length,
      annotations: annotations.length,
      adjudications: adjudications.length,
      unitDatasetSha256: unitDatasetDigest(units),
      annotationDatasetSha256: annotationDatasetDigest(annotations),
      adjudicationDatasetSha256: adjudicationDatasetDigest(adjudications),
    },
    output: {
      units: redactedUnits.length,
      annotations: redactedAnnotations.length,
      adjudications: redactedAdjudications.length,
      unitDatasetSha256: unitDatasetDigest(redactedUnits),
      annotationDatasetSha256: annotationDatasetDigest(redactedAnnotations),
      adjudicationDatasetSha256: adjudicationDatasetDigest(
        redactedAdjudications,
      ),
    },
    removed: {
      units: units.length - redactedUnits.length,
      annotations: annotations.length - redactedAnnotations.length,
      adjudications: adjudications.length - redactedAdjudications.length,
      unitSetSha256: hashState(removedUnitHashes),
    },
    invalidation: {
      priorFinalizedRecordsMustBeDeleted: true,
      priorLabelingReportsMustBeDeleted: true,
      priorAnalysisReportsMustBeDeleted: true,
      finalizationAndAnalysisMustBeRerun: true,
    },
  };

  return {
    units: redactedUnits,
    annotations: redactedAnnotations,
    adjudications: redactedAdjudications,
    receipt,
  };
}

export async function writeRedactedLearnLoopStudyData(
  unitsOutputFile: string,
  annotationsOutputFile: string,
  adjudicationsOutputFile: string,
  receiptOutputFile: string,
  redacted: RedactedLearnLoopStudyData,
): Promise<void> {
  const outputs = [
    {
      path: resolve(unitsOutputFile),
      content: jsonLines(redacted.units),
    },
    {
      path: resolve(annotationsOutputFile),
      content: jsonLines(redacted.annotations),
    },
    {
      path: resolve(adjudicationsOutputFile),
      content: jsonLines(redacted.adjudications),
    },
    {
      path: resolve(receiptOutputFile),
      content: `${JSON.stringify(redacted.receipt, null, 2)}\n`,
    },
  ];
  if (new Set(outputs.map((output) => output.path)).size !== outputs.length) {
    throw new Error("Study withdrawal output paths must all be different.");
  }
  await Promise.all(
    outputs.map((output) => mkdir(dirname(output.path), { recursive: true })),
  );
  const created: string[] = [];
  try {
    for (const output of outputs) {
      await writeFile(output.path, output.content, {
        encoding: "utf8",
        flag: "wx",
      });
      created.push(output.path);
    }
  } catch (error) {
    await Promise.all(created.map((path) => rm(path, { force: true })));
    throw error;
  }
}

function assertRowsBoundToKnownUnits(
  rows: Array<{ planSha256: string; unitHash: string }>,
  unitHashes: Set<string>,
  planSha256: string,
  name: string,
): void {
  for (const row of rows) {
    if (row.planSha256 !== planSha256) {
      throw new Error(`${name} uses a different frozen plan.`);
    }
    if (!unitHashes.has(row.unitHash)) {
      throw new Error(`${name} references an unknown blind unit.`);
    }
  }
}

function assertUniqueRows(keys: string[], name: string): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`${name} is duplicated.`);
    seen.add(key);
  }
}

function unitDatasetDigest(units: LearnLoopStudyBlindUnit[]): string {
  return hashState(
    [...units].sort((left, right) =>
      hashLearnLoopStudyBlindUnit(left).localeCompare(
        hashLearnLoopStudyBlindUnit(right),
      ),
    ),
  );
}

function annotationDatasetDigest(
  annotations: LearnLoopStudyAnnotationRecord[],
): string {
  return hashState(
    [...annotations].sort((left, right) =>
      annotationSortKey(left).localeCompare(annotationSortKey(right)),
    ),
  );
}

function adjudicationDatasetDigest(
  adjudications: LearnLoopStudyAdjudicationRecord[],
): string {
  return hashState(
    [...adjudications].sort((left, right) =>
      adjudicationSortKey(left).localeCompare(adjudicationSortKey(right)),
    ),
  );
}

function annotationSortKey(annotation: LearnLoopStudyAnnotationRecord): string {
  return `${annotation.unitHash}:${annotation.annotatorHash}`;
}

function adjudicationSortKey(
  adjudication: LearnLoopStudyAdjudicationRecord,
): string {
  return `${adjudication.unitHash}:${adjudication.adjudicatorHash}`;
}

function jsonLines(values: unknown[]): string {
  if (values.length === 0) return "";
  return `${values.map((value) => JSON.stringify(value)).join("\n")}\n`;
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
