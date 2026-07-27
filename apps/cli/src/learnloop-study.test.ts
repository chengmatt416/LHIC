import { describe, expect, it } from "vitest";

import { hashState } from "@lhic/trace";

import {
  analyzeLearnLoopStudy,
  hashLearnLoopStudyPlan,
  parseLearnLoopStudyPlan,
  parseLearnLoopStudyRecords,
  type LearnLoopStudyPlan,
  type LearnLoopStudyRecord,
  type LearnLoopStudyStage,
} from "./learnloop-study.js";

describe("LearnLoop preregistered study analysis", () => {
  it("reports paired accuracy, uncertainty, calibration, and language strata", () => {
    const plan = studyPlan();
    const records = studyRecords(plan, 40, 12);
    const report = analyzeLearnLoopStudy(plan, records);

    expect(report.methodology.includedEvaluationUnits).toBe(40);
    expect(report.metrics.base.top1Accuracy).toBe(0.7);
    expect(report.metrics.learned.top1Accuracy).toBe(1);
    expect(report.metrics.accuracyGain).toBeCloseTo(0.3);
    expect(report.metrics.pairedDiscordance).toMatchObject({
      baseCorrectLearnedWrong: 0,
      baseWrongLearnedCorrect: 12,
      method: "exact-binomial-mcnemar",
    });
    expect(report.metrics.pairedDiscordance.twoSidedPValue).toBeLessThan(0.001);
    expect(report.metrics.learned.wrongFastAdmissionRate).toBe(0);
    expect(report.metrics.learned.wrongFastAdmissionRateInterval.upper).toBeLessThan(
      0.1,
    );
    expect(report.metrics.languageResults.en?.count).toBe(20);
    expect(report.metrics.languageResults["zh-TW"]?.count).toBe(20);
    expect(report.passed).toBe(true);
  });

  it("rejects participant, session, task, and UI-variant leakage", () => {
    const plan = studyPlan();
    const records = studyRecords(plan, 40, 12);
    const training = records.find((record) => record.split === "training");
    const evaluationIndex = records.findIndex(
      (record) => record.split === "evaluation",
    );
    expect(training).toBeDefined();
    expect(evaluationIndex).toBeGreaterThan(-1);

    for (const field of [
      "participantHash",
      "sessionHash",
      "taskHash",
      "uiVariantHash",
    ] as const) {
      const mutated = structuredClone(records);
      mutated[evaluationIndex]![field] = training![field];
      expect(() => analyzeLearnLoopStudy(plan, mutated)).toThrow("leakage");
    }
  });

  it("rejects plan substitution, raw extra fields, and withdrawn records", () => {
    const plan = studyPlan();
    const records = studyRecords(plan, 40, 12);
    const substituted = structuredClone(records);
    substituted[0]!.planSha256 = digest("different-plan");
    expect(() => analyzeLearnLoopStudy(plan, substituted)).toThrow(
      "different plan",
    );

    const withRawGoal = {
      ...records[0],
      rawGoal: "Search for a confidential project",
    };
    expect(() => parseLearnLoopStudyRecords([withRawGoal])).toThrow(
      "unexpected or missing fields",
    );

    const withdrawn = { ...structuredClone(records[0]), withdrawn: true };
    expect(() => parseLearnLoopStudyRecords([withdrawn])).toThrow(
      "must be deleted",
    );
  });

  it("rejects records collected before freeze or with a different collector", () => {
    const plan = studyPlan();
    const records = studyRecords(plan, 40, 12);
    const stale = structuredClone(records);
    stale[0]!.recordedAt = "2026-07-26T23:59:59.999Z";
    expect(() => analyzeLearnLoopStudy(plan, stale)).toThrow("predates");

    const wrongCollector = structuredClone(records);
    wrongCollector[0]!.collectorVersion = "lhic-study-collector-2.0.0";
    expect(() => analyzeLearnLoopStudy(plan, wrongCollector)).toThrow(
      "different collector version",
    );
  });

  it("uses a conservative wrong-fast upper bound for small samples", () => {
    const plan = {
      ...studyPlan(),
      minimumEvaluationUnits: 10,
    } satisfies LearnLoopStudyPlan;
    const report = analyzeLearnLoopStudy(plan, studyRecords(plan, 10, 6));
    expect(report.metrics.learned.wrongFastAdmissionRate).toBe(0);
    expect(report.metrics.learned.wrongFastAdmissionRateInterval.upper).toBeGreaterThan(
      0.1,
    );
    expect(report.passCriteria.wrongFastAdmissionUpperBound).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("produces an order-independent dataset digest", () => {
    const plan = studyPlan();
    const records = studyRecords(plan, 40, 12);
    const forward = analyzeLearnLoopStudy(plan, records);
    const reversed = analyzeLearnLoopStudy(plan, [...records].reverse());
    expect(reversed.datasetSha256).toBe(forward.datasetSha256);
  });

  it("rejects unfrozen or weakly specified plans", () => {
    const plan = studyPlan();
    expect(() =>
      parseLearnLoopStudyPlan({
        ...plan,
        frozenAt: "2026-07-27",
      }),
    ).toThrow("canonical UTC ISO");
    expect(() =>
      parseLearnLoopStudyPlan({
        ...plan,
        requiredLanguages: ["en", "en"],
      }),
    ).toThrow("unique language tags");
  });
});

function studyPlan(): LearnLoopStudyPlan {
  return {
    schemaVersion: "lhic-learnloop-study-plan-v1",
    studyId: "xtf-learnloop-paired-pilot-001",
    protocolVersion: "1.0.0",
    collectorVersion: "lhic-study-collector-1.0.0",
    frozenAt: "2026-07-27T00:00:00.000Z",
    design: "paired-offline-intent-v1",
    minimumEvaluationUnits: 40,
    confidenceLevel: 0.95,
    calibrationBins: 10,
    requiredLanguages: ["en", "zh-TW"],
    minimumEvaluationUnitsPerLanguage: 15,
    thresholds: {
      minimumAccuracyGain: 0.2,
      maximumWrongFastAdmissionUpperBound: 0.1,
      maximumLearnedP95LatencyMs: 20,
      maximumLearnedExpectedCalibrationError: 0.15,
      significanceAlpha: 0.05,
      minimumDistinctExpectedStages: 4,
    },
  };
}

function studyRecords(
  plan: LearnLoopStudyPlan,
  evaluationCount: number,
  baseErrorCount: number,
): LearnLoopStudyRecord[] {
  const planSha256 = hashLearnLoopStudyPlan(plan);
  const training = Array.from({ length: 4 }, (_, index) =>
    studyRecord({
      planSha256,
      split: "training",
      index,
      prefix: "training",
      expectedStage: stages[index % stages.length]!,
      baseWrong: false,
    }),
  );
  const evaluation = Array.from({ length: evaluationCount }, (_, index) =>
    studyRecord({
      planSha256,
      split: "evaluation",
      index,
      prefix: "evaluation",
      expectedStage: stages[index % stages.length]!,
      baseWrong: index < baseErrorCount,
    }),
  );
  return [...training, ...evaluation];
}

const stages: LearnLoopStudyStage[] = [
  "login",
  "form_filling",
  "search",
  "download",
];

function studyRecord(input: {
  planSha256: string;
  split: "training" | "evaluation";
  index: number;
  prefix: string;
  expectedStage: LearnLoopStudyStage;
  baseWrong: boolean;
}): LearnLoopStudyRecord {
  const baseStage = input.baseWrong
    ? wrongStage(input.expectedStage)
    : input.expectedStage;
  return {
    schemaVersion: "lhic-learnloop-study-record-v1",
    planSha256: input.planSha256,
    split: input.split,
    participantHash: digest(`${input.prefix}:participant:${input.index}`),
    sessionHash: digest(`${input.prefix}:session:${input.index}`),
    taskHash: digest(`${input.prefix}:task:${input.index}`),
    uiVariantHash: digest(`${input.prefix}:ui:${input.index}`),
    language: input.index % 2 === 0 ? "en" : "zh-TW",
    recordedAt: "2026-07-27T00:00:00.000Z",
    collectorVersion: "lhic-study-collector-1.0.0",
    consented: true,
    withdrawn: false,
    exclusionCode: "none",
    expectedStage: input.expectedStage,
    base: {
      predictedStage: baseStage,
      confidence: input.baseWrong ? 0.8 : 0.85,
      admission: "execute_fast",
      latencyMs: 0.8,
    },
    learned: {
      predictedStage: input.expectedStage,
      confidence: 0.9,
      admission: "execute_fast",
      latencyMs: 1.2,
    },
  };
}

function wrongStage(stage: LearnLoopStudyStage): LearnLoopStudyStage {
  switch (stage) {
    case "login":
      return "search";
    case "form_filling":
      return "login";
    case "search":
      return "download";
    case "download":
      return "form_filling";
    case "test_web_flow":
      return "unknown";
    case "unknown":
      return "login";
  }
}

function digest(value: string): string {
  return hashState(value);
}
