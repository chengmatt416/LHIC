import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashState } from "@lhic/trace";
import { describe, expect, it } from "vitest";

import {
  finalizeLearnLoopStudyLabels,
  hashLearnLoopStudyBlindUnit,
  parseLearnLoopStudyAdjudications,
  parseLearnLoopStudyAnnotations,
  type LearnLoopStudyAdjudicationRecord,
  type LearnLoopStudyAnnotationRecord,
  type LearnLoopStudyBlindUnit,
  writeFinalizedLearnLoopStudyLabels,
} from "./learnloop-study-labeling.js";
import {
  hashLearnLoopStudyPlan,
  type LearnLoopStudyPlan,
  type LearnLoopStudyStage,
} from "./learnloop-study.js";

const stages: LearnLoopStudyStage[] = [
  "login",
  "form_filling",
  "search",
  "download",
];

describe("LearnLoop blinded study labeling", () => {
  it("finalizes two blinded labels per unit and requires independent adjudication", () => {
    const fixture = labelingFixture();
    const finalized = finalizeLearnLoopStudyLabels(
      fixture.plan,
      fixture.units,
      fixture.annotations,
      fixture.adjudications,
    );

    expect(finalized.records).toHaveLength(4);
    expect(finalized.report.counts).toMatchObject({
      units: 4,
      annotations: 8,
      adjudications: 1,
      agreedUnits: 3,
      disagreedUnits: 1,
    });
    expect(finalized.report.agreement.rawAgreement).toBe(0.75);
    expect(finalized.report.agreement.fleissKappa).toBeLessThan(1);
    expect(finalized.report.agreement.fleissKappa).toBeGreaterThan(0);
    expect(
      finalized.records.find(
        (record) =>
          hashLearnLoopStudyBlindUnit(withoutExpectedStage(record)) ===
          fixture.disagreedUnitHash,
      )?.expectedStage,
    ).toBe("download");
    expect(finalized.report.methodology.blindedToArm).toBe(true);
  });

  it("produces order-independent dataset digests", () => {
    const fixture = labelingFixture();
    const forward = finalizeLearnLoopStudyLabels(
      fixture.plan,
      fixture.units,
      fixture.annotations,
      fixture.adjudications,
    );
    const reversed = finalizeLearnLoopStudyLabels(
      fixture.plan,
      [...fixture.units].reverse(),
      [...fixture.annotations].reverse(),
      [...fixture.adjudications].reverse(),
    );

    expect(reversed.report.unitDatasetSha256).toBe(
      forward.report.unitDatasetSha256,
    );
    expect(reversed.report.annotationDatasetSha256).toBe(
      forward.report.annotationDatasetSha256,
    );
    expect(reversed.report.adjudicationDatasetSha256).toBe(
      forward.report.adjudicationDatasetSha256,
    );
    expect(reversed.report.finalizedRecordsSha256).toBe(
      forward.report.finalizedRecordsSha256,
    );
  });

  it("rejects duplicate annotators and missing adjudication", () => {
    const duplicate = labelingFixture();
    duplicate.annotations[1]!.annotatorHash =
      duplicate.annotations[0]!.annotatorHash;
    expect(() =>
      finalizeLearnLoopStudyLabels(
        duplicate.plan,
        duplicate.units,
        duplicate.annotations,
        duplicate.adjudications,
      ),
    ).toThrow("distinct annotators");

    const missing = labelingFixture();
    expect(() =>
      finalizeLearnLoopStudyLabels(
        missing.plan,
        missing.units,
        missing.annotations,
        [],
      ),
    ).toThrow("requires exactly one adjudication");
  });

  it("rejects an adjudicator who also labeled the unit", () => {
    const fixture = labelingFixture();
    const labels = fixture.annotations.filter(
      (annotation) => annotation.unitHash === fixture.disagreedUnitHash,
    );
    fixture.adjudications[0]!.adjudicatorHash = labels[0]!.annotatorHash;

    expect(() =>
      finalizeLearnLoopStudyLabels(
        fixture.plan,
        fixture.units,
        fixture.annotations,
        fixture.adjudications,
      ),
    ).toThrow("adjudicator must be independent");
  });

  it("rejects unblinded and structurally extended label rows", () => {
    const fixture = labelingFixture();
    expect(() =>
      parseLearnLoopStudyAnnotations([
        {
          ...fixture.annotations[0],
          blindedToArm: false,
        },
      ]),
    ).toThrow("not blinded");
    expect(() =>
      parseLearnLoopStudyAdjudications([
        {
          ...fixture.adjudications[0],
          rawTaskText: "must not be collected",
        },
      ]),
    ).toThrow("missing or unexpected fields");
  });

  it("rolls back finalized records when the report cannot be created", async () => {
    const fixture = labelingFixture();
    const finalized = finalizeLearnLoopStudyLabels(
      fixture.plan,
      fixture.units,
      fixture.annotations,
      fixture.adjudications,
    );
    const directory = await mkdtemp(join(tmpdir(), "lhic-labeling-"));
    const recordsFile = join(directory, "records.jsonl");
    const reportFile = join(directory, "report.json");
    await writeFile(reportFile, "reserved", "utf8");

    await expect(
      writeFinalizedLearnLoopStudyLabels(recordsFile, reportFile, finalized),
    ).rejects.toThrow();
    await expect(readFile(recordsFile, "utf8")).rejects.toThrow();
  });
});

function labelingFixture(): {
  plan: LearnLoopStudyPlan;
  units: LearnLoopStudyBlindUnit[];
  annotations: LearnLoopStudyAnnotationRecord[];
  adjudications: LearnLoopStudyAdjudicationRecord[];
  disagreedUnitHash: string;
} {
  const plan = studyPlan();
  const planSha256 = hashLearnLoopStudyPlan(plan);
  const units = [
    blindUnit(planSha256, "training", 0),
    blindUnit(planSha256, "training", 1),
    blindUnit(planSha256, "evaluation", 2),
    blindUnit(planSha256, "evaluation", 3),
  ];
  const annotations: LearnLoopStudyAnnotationRecord[] = [];
  let disagreedUnitHash = "";

  for (const [index, unit] of units.entries()) {
    const unitHash = hashLearnLoopStudyBlindUnit(unit);
    const expectedStage = stages[index]!;
    annotations.push(
      annotation(
        planSha256,
        unitHash,
        `annotator-a-${index}`,
        expectedStage,
        1,
      ),
      annotation(
        planSha256,
        unitHash,
        `annotator-b-${index}`,
        index === 3 ? "search" : expectedStage,
        2,
      ),
    );
    if (index === 3) disagreedUnitHash = unitHash;
  }

  return {
    plan,
    units,
    annotations,
    adjudications: [
      {
        schemaVersion: "lhic-learnloop-study-adjudication-v1",
        planSha256,
        unitHash: disagreedUnitHash,
        adjudicatorHash: digest("adjudicator-independent"),
        finalStage: "download",
        reasonCode: "third_rater_consensus",
        recordedAt: "2026-07-27T00:03:00.000Z",
        blindedToArm: true,
      },
    ],
    disagreedUnitHash,
  };
}

function studyPlan(): LearnLoopStudyPlan {
  return {
    schemaVersion: "lhic-learnloop-study-plan-v1",
    studyId: "xtf-learnloop-labeling-pilot-001",
    protocolVersion: "1.0.0",
    collectorVersion: "lhic-study-collector-1.0.0",
    lhicCommitSha: "dd332ecc62591144833cf36dd3783739f480e7a3",
    frozenAt: "2026-07-27T00:00:00.000Z",
    design: "paired-offline-intent-v1",
    minimumEvaluationUnits: 10,
    confidenceLevel: 0.95,
    calibrationBins: 10,
    requiredLanguages: ["en", "zh-TW"],
    minimumEvaluationUnitsPerLanguage: 5,
    thresholds: {
      minimumAccuracyGain: 0.1,
      maximumWrongFastAdmissionUpperBound: 0.2,
      maximumLearnedP95LatencyMs: 20,
      maximumLearnedExpectedCalibrationError: 0.2,
      significanceAlpha: 0.05,
      minimumDistinctExpectedStages: 2,
    },
  };
}

function blindUnit(
  planSha256: string,
  split: "training" | "evaluation",
  index: number,
): LearnLoopStudyBlindUnit {
  return {
    schemaVersion: "lhic-learnloop-study-record-v1",
    planSha256,
    split,
    participantHash: digest(`${split}-participant-${index}`),
    sessionHash: digest(`${split}-session-${index}`),
    taskHash: digest(`${split}-task-${index}`),
    uiVariantHash: digest(`${split}-ui-${index}`),
    language: index % 2 === 0 ? "en" : "zh-TW",
    recordedAt: "2026-07-27T00:00:30.000Z",
    collectorVersion: "lhic-study-collector-1.0.0",
    consented: true,
    withdrawn: false,
    exclusionCode: "none",
    base: {
      predictedStage: stages[(index + 1) % stages.length]!,
      confidence: 0.55,
      admission: "require_confirmation",
      latencyMs: 1,
    },
    learned: {
      predictedStage: stages[index]!,
      confidence: 0.9,
      admission: "execute_fast",
      latencyMs: 1.5,
    },
  };
}

function annotation(
  planSha256: string,
  unitHash: string,
  annotator: string,
  expectedStage: LearnLoopStudyStage,
  minute: number,
): LearnLoopStudyAnnotationRecord {
  return {
    schemaVersion: "lhic-learnloop-study-annotation-v1",
    planSha256,
    unitHash,
    annotatorHash: digest(annotator),
    expectedStage,
    recordedAt: `2026-07-27T00:0${minute}:00.000Z`,
    blindedToArm: true,
  };
}

function withoutExpectedStage(
  record: LearnLoopStudyBlindUnit & { expectedStage: LearnLoopStudyStage },
): LearnLoopStudyBlindUnit {
  const { expectedStage, ...unit } = record;
  void expectedStage;
  return unit;
}

function digest(value: string): string {
  return hashState(value);
}
