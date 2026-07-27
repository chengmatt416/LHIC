import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hashState } from "@lhic/trace";
import { describe, expect, it } from "vitest";

import {
  buildLearnLoopStudySchedule,
  parseLearnLoopStudyParticipants,
  parseLearnLoopStudyTaskManifest,
  writeLearnLoopStudySchedule,
  type LearnLoopStudyParticipantEnrollment,
  type LearnLoopStudyTaskManifest,
} from "./learnloop-study-schedule.js";
import {
  hashLearnLoopStudyPlan,
  type LearnLoopStudyPlan,
} from "./learnloop-study.js";

describe("LearnLoop preregistered study scheduling", () => {
  it("produces deterministic balanced assignments without labels or model outputs", () => {
    const fixture = scheduleFixture();
    const forward = buildLearnLoopStudySchedule(
      fixture.plan,
      fixture.manifest,
      fixture.participants,
    );
    const reversedParticipants = buildLearnLoopStudySchedule(
      fixture.plan,
      fixture.manifest,
      [...fixture.participants].reverse(),
    );

    expect(reversedParticipants).toEqual(forward);
    expect(forward.counts.evaluationAssignments).toBe(8);
    expect(forward.counts.evaluationAssignmentsPerLanguage).toEqual({
      en: 4,
      "zh-TW": 4,
    });
    expect(forward.qualityChecks.maximumUiVariantImbalance).toBeLessThanOrEqual(
      1,
    );
    expect(forward.containsGoldLabels).toBe(false);
    expect(forward.containsModelOutputs).toBe(false);
    expect(JSON.stringify(forward.assignments)).not.toContain("expectedStage");
    expect(JSON.stringify(forward.assignments)).not.toContain("predictedStage");
    for (const participant of fixture.participants) {
      const rows = forward.assignments.filter(
        (assignment) =>
          assignment.participantHash === participant.participantHash,
      );
      expect(rows.map((row) => row.sequence)).toEqual(
        rows.map((_, index) => index + 1),
      );
    }
  });

  it("rejects train/evaluation task or UI identity leakage", () => {
    const fixture = scheduleFixture();
    const duplicateTask = structuredClone(fixture.manifest);
    duplicateTask.taskFamilies[2]!.taskHash =
      duplicateTask.taskFamilies[0]!.taskHash;
    expect(() =>
      parseLearnLoopStudyTaskManifest(fixture.plan, duplicateTask),
    ).toThrow("task hashes must be globally unique");

    const duplicateVariant = structuredClone(fixture.manifest);
    duplicateVariant.taskFamilies[3]!.uiVariantHashes[0] =
      duplicateVariant.taskFamilies[0]!.uiVariantHashes[0]!;
    expect(() =>
      parseLearnLoopStudyTaskManifest(fixture.plan, duplicateVariant),
    ).toThrow("UI variant hashes must be globally unique");
  });

  it("rejects post-freeze substitutions, invalid consent, and duplicate participants", () => {
    const fixture = scheduleFixture();
    const wrongPlan = structuredClone(fixture.manifest);
    wrongPlan.planSha256 = digest("different-plan");
    expect(() =>
      parseLearnLoopStudyTaskManifest(fixture.plan, wrongPlan),
    ).toThrow("different plan");

    const invalidConsent = structuredClone(fixture.participants) as unknown[];
    (invalidConsent[0] as Record<string, unknown>).consented = false;
    expect(() =>
      parseLearnLoopStudyParticipants(fixture.plan, invalidConsent),
    ).toThrow("consented and not withdrawn");

    const duplicates = [
      ...fixture.participants,
      structuredClone(fixture.participants[0]!),
    ];
    expect(() =>
      parseLearnLoopStudyParticipants(fixture.plan, duplicates),
    ).toThrow("participant hashes must be unique");
  });

  it("fails when the frozen enrollment cannot satisfy sample or language minima", () => {
    const fixture = scheduleFixture();
    const insufficient = fixture.participants.filter(
      (participant) =>
        participant.split === "training" || participant.language === "en",
    );
    expect(() =>
      buildLearnLoopStudySchedule(fixture.plan, fixture.manifest, insufficient),
    ).toThrow("evaluation minimum for zh-TW");
  });

  it("writes a non-overwritable schedule", async () => {
    const fixture = scheduleFixture();
    const schedule = buildLearnLoopStudySchedule(
      fixture.plan,
      fixture.manifest,
      fixture.participants,
    );
    const directory = await mkdtemp(join(tmpdir(), "lhic-study-schedule-"));
    const outputFile = join(directory, "schedule.json");

    await writeLearnLoopStudySchedule(outputFile, schedule);
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toEqual(schedule);
    await expect(
      writeLearnLoopStudySchedule(outputFile, schedule),
    ).rejects.toThrow();

    const reservedFile = join(directory, "reserved.json");
    await writeFile(reservedFile, "reserved", "utf8");
    await expect(
      writeLearnLoopStudySchedule(reservedFile, schedule),
    ).rejects.toThrow();
    await expect(readFile(reservedFile, "utf8")).resolves.toBe("reserved");
  });
});

function scheduleFixture(): {
  plan: LearnLoopStudyPlan;
  manifest: LearnLoopStudyTaskManifest;
  participants: LearnLoopStudyParticipantEnrollment[];
} {
  const plan = studyPlan();
  const planSha256 = hashLearnLoopStudyPlan(plan);
  const manifest: LearnLoopStudyTaskManifest = {
    schemaVersion: "lhic-learnloop-study-task-manifest-v1",
    planSha256,
    manifestId: "xtf-study-manifest-v1",
    frozenAt: "2026-07-27T01:00:00.000Z",
    rubricVersion: "stage-rubric-v1",
    randomizationSeedSha256: digest("randomization-seed"),
    access: "restricted-coordinator",
    containsGoldLabels: true,
    taskFamilies: [
      taskFamily("training-en-login", "training", "en", "login"),
      taskFamily("training-zh-search", "training", "zh-TW", "search"),
      taskFamily("evaluation-en-login", "evaluation", "en", "login"),
      taskFamily("evaluation-en-search", "evaluation", "en", "search"),
      taskFamily("evaluation-zh-form", "evaluation", "zh-TW", "form_filling"),
      taskFamily("evaluation-zh-download", "evaluation", "zh-TW", "download"),
    ],
  };
  const participants: LearnLoopStudyParticipantEnrollment[] = [
    participant(planSha256, "training-en", "training", "en"),
    participant(planSha256, "training-zh", "training", "zh-TW"),
    participant(planSha256, "evaluation-en-a", "evaluation", "en"),
    participant(planSha256, "evaluation-en-b", "evaluation", "en"),
    participant(planSha256, "evaluation-zh-a", "evaluation", "zh-TW"),
    participant(planSha256, "evaluation-zh-b", "evaluation", "zh-TW"),
  ];
  return { plan, manifest, participants };
}

function studyPlan(): LearnLoopStudyPlan {
  return {
    schemaVersion: "lhic-learnloop-study-plan-v1",
    studyId: "xtf-schedule-test",
    protocolVersion: "1.0.0",
    collectorVersion: "1.0.0",
    lhicCommitSha: "0".repeat(40),
    frozenAt: "2026-07-27T00:00:00.000Z",
    design: "paired-offline-intent-v1",
    minimumEvaluationUnits: 8,
    confidenceLevel: 0.95,
    calibrationBins: 10,
    requiredLanguages: ["en", "zh-TW"],
    minimumEvaluationUnitsPerLanguage: 4,
    thresholds: {
      minimumAccuracyGain: 0.1,
      maximumWrongFastAdmissionUpperBound: 0.1,
      maximumLearnedP95LatencyMs: 50,
      maximumLearnedExpectedCalibrationError: 0.15,
      significanceAlpha: 0.05,
      minimumDistinctExpectedStages: 4,
    },
  };
}

function taskFamily(
  label: string,
  split: "training" | "evaluation",
  language: string,
  expectedStage:
    | "login"
    | "form_filling"
    | "search"
    | "download"
    | "test_web_flow"
    | "unknown",
): LearnLoopStudyTaskManifest["taskFamilies"][number] {
  return {
    taskHash: digest(`${label}-task`),
    split,
    language,
    expectedStage,
    uiVariantHashes: [digest(`${label}-ui-a`), digest(`${label}-ui-b`)],
  };
}

function participant(
  planSha256: string,
  label: string,
  split: "training" | "evaluation",
  language: string,
): LearnLoopStudyParticipantEnrollment {
  return {
    schemaVersion: "lhic-learnloop-study-participant-v1",
    planSha256,
    participantHash: digest(label),
    split,
    language,
    enrolledAt: "2026-07-27T02:00:00.000Z",
    consented: true,
    withdrawn: false,
  };
}

function digest(label: string): string {
  return hashState({ label });
}
