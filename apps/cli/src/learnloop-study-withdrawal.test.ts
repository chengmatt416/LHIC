import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashState } from "@lhic/trace";
import { describe, expect, it } from "vitest";

import {
  hashLearnLoopStudyBlindUnit,
  type LearnLoopStudyAdjudicationRecord,
  type LearnLoopStudyAnnotationRecord,
  type LearnLoopStudyBlindUnit,
} from "./learnloop-study-labeling.js";
import {
  hashLearnLoopStudyPlan,
  type LearnLoopStudyPlan,
  type LearnLoopStudyStage,
} from "./learnloop-study.js";
import {
  redactLearnLoopStudyParticipant,
  writeRedactedLearnLoopStudyData,
} from "./learnloop-study-withdrawal.js";

describe("LearnLoop participant withdrawal", () => {
  it("removes participant units and every linked labeling row", () => {
    const fixture = withdrawalFixture();
    const redacted = redactLearnLoopStudyParticipant(
      fixture.units,
      fixture.annotations,
      fixture.adjudications,
      fixture.withdrawnParticipantHash,
      "2026-07-27T01:00:00.000Z",
    );

    expect(redacted.units).toHaveLength(1);
    expect(redacted.annotations).toHaveLength(2);
    expect(redacted.adjudications).toHaveLength(0);
    expect(redacted.receipt.removed).toMatchObject({
      units: 2,
      annotations: 4,
      adjudications: 1,
    });
    const removedUnitHashes = fixture.units
      .filter(
        (unit) => unit.participantHash === fixture.withdrawnParticipantHash,
      )
      .map((unit) => hashLearnLoopStudyBlindUnit(unit))
      .sort();
    expect(redacted.receipt.removed.unitSetSha256).toBe(
      hashState(removedUnitHashes),
    );
    expect(redacted.receipt.removed).not.toHaveProperty("unitHashes");
    expect(redacted.receipt.withdrawalSubjectCommitment).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(
      redacted.receipt.invalidation.priorFinalizedRecordsMustBeDeleted,
    ).toBe(true);
    expect(
      redacted.receipt.invalidation.finalizationAndAnalysisMustBeRerun,
    ).toBe(true);
  });

  it("produces order-independent before and after digests", () => {
    const fixture = withdrawalFixture();
    const forward = redactLearnLoopStudyParticipant(
      fixture.units,
      fixture.annotations,
      fixture.adjudications,
      fixture.withdrawnParticipantHash,
      "2026-07-27T01:00:00.000Z",
    );
    const reversed = redactLearnLoopStudyParticipant(
      [...fixture.units].reverse(),
      [...fixture.annotations].reverse(),
      [...fixture.adjudications].reverse(),
      fixture.withdrawnParticipantHash,
      "2026-07-27T01:00:00.000Z",
    );

    expect(reversed.receipt.input).toEqual(forward.receipt.input);
    expect(reversed.receipt.output).toEqual(forward.receipt.output);
    expect(reversed.receipt.removed).toEqual(forward.receipt.removed);
  });

  it("rejects an unknown participant and orphan annotation rows", () => {
    const fixture = withdrawalFixture();
    expect(() =>
      redactLearnLoopStudyParticipant(
        fixture.units,
        fixture.annotations,
        fixture.adjudications,
        digest("unknown-participant"),
        "2026-07-27T01:00:00.000Z",
      ),
    ).toThrow("participant was not found");

    const orphaned = structuredClone(fixture.annotations);
    orphaned[0]!.unitHash = digest("missing-unit");
    expect(() =>
      redactLearnLoopStudyParticipant(
        fixture.units,
        orphaned,
        fixture.adjudications,
        fixture.withdrawnParticipantHash,
        "2026-07-27T01:00:00.000Z",
      ),
    ).toThrow("unknown blind unit");
  });

  it("supports withdrawal before labeling and rejects an impossible timestamp", () => {
    const fixture = withdrawalFixture();
    const beforeLabeling = redactLearnLoopStudyParticipant(
      fixture.units,
      [],
      [],
      fixture.withdrawnParticipantHash,
      "2026-07-27T01:00:00.000Z",
    );
    expect(beforeLabeling.annotations).toHaveLength(0);
    expect(beforeLabeling.adjudications).toHaveLength(0);

    expect(() =>
      redactLearnLoopStudyParticipant(
        fixture.units,
        fixture.annotations,
        fixture.adjudications,
        fixture.withdrawnParticipantHash,
        "2026-07-26T23:59:59.000Z",
      ),
    ).toThrow("predates a source record");
  });

  it("rolls back all newly created files if one output is reserved", async () => {
    const fixture = withdrawalFixture();
    const redacted = redactLearnLoopStudyParticipant(
      fixture.units,
      fixture.annotations,
      fixture.adjudications,
      fixture.withdrawnParticipantHash,
      "2026-07-27T01:00:00.000Z",
    );
    const directory = await mkdtemp(join(tmpdir(), "lhic-withdrawal-"));
    const unitsFile = join(directory, "units.jsonl");
    const annotationsFile = join(directory, "annotations.jsonl");
    const adjudicationsFile = join(directory, "adjudications.jsonl");
    const receiptFile = join(directory, "receipt.json");
    await writeFile(adjudicationsFile, "reserved", "utf8");

    await expect(
      writeRedactedLearnLoopStudyData(
        unitsFile,
        annotationsFile,
        adjudicationsFile,
        receiptFile,
        redacted,
      ),
    ).rejects.toThrow();
    await expect(readFile(unitsFile, "utf8")).rejects.toThrow();
    await expect(readFile(annotationsFile, "utf8")).rejects.toThrow();
    await expect(readFile(receiptFile, "utf8")).rejects.toThrow();
    await expect(readFile(adjudicationsFile, "utf8")).resolves.toBe("reserved");
  });
});

function withdrawalFixture(): {
  units: LearnLoopStudyBlindUnit[];
  annotations: LearnLoopStudyAnnotationRecord[];
  adjudications: LearnLoopStudyAdjudicationRecord[];
  withdrawnParticipantHash: string;
} {
  const plan = studyPlan();
  const planSha256 = hashLearnLoopStudyPlan(plan);
  const withdrawnParticipantHash = digest("participant-withdrawn");
  const units = [
    blindUnit(planSha256, withdrawnParticipantHash, 0),
    blindUnit(planSha256, withdrawnParticipantHash, 1),
    blindUnit(planSha256, digest("participant-retained"), 2),
  ];
  const annotations: LearnLoopStudyAnnotationRecord[] = [];
  const adjudications: LearnLoopStudyAdjudicationRecord[] = [];
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
        index === 1 ? "search" : expectedStage,
        2,
      ),
    );
    if (index === 1) {
      adjudications.push({
        schemaVersion: "lhic-learnloop-study-adjudication-v1",
        planSha256,
        unitHash,
        adjudicatorHash: digest("adjudicator-independent"),
        finalStage: expectedStage,
        reasonCode: "evidence_review",
        recordedAt: "2026-07-27T00:03:00.000Z",
        blindedToArm: true,
      });
    }
  }
  return {
    units,
    annotations,
    adjudications,
    withdrawnParticipantHash,
  };
}

const stages: LearnLoopStudyStage[] = ["login", "download", "search"];

function studyPlan(): LearnLoopStudyPlan {
  return {
    schemaVersion: "lhic-learnloop-study-plan-v1",
    studyId: "xtf-learnloop-withdrawal-pilot-001",
    protocolVersion: "1.0.0",
    collectorVersion: "lhic-study-collector-1.0.0",
    lhicCommitSha: "b2976e53490618f8ff18a55e8588f1432db8667e",
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
  participantHash: string,
  index: number,
): LearnLoopStudyBlindUnit {
  return {
    schemaVersion: "lhic-learnloop-study-record-v1",
    planSha256,
    split: index === 2 ? "training" : "evaluation",
    participantHash,
    sessionHash: digest(`session-${index}`),
    taskHash: digest(`task-${index}`),
    uiVariantHash: digest(`ui-${index}`),
    language: index % 2 === 0 ? "en" : "zh-TW",
    recordedAt: "2026-07-27T00:00:30.000Z",
    collectorVersion: "lhic-study-collector-1.0.0",
    consented: true,
    withdrawn: false,
    exclusionCode: "none",
    base: {
      predictedStage: "unknown",
      confidence: 0.5,
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

function digest(value: string): string {
  return hashState(value);
}
