import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { hashState } from "@lhic/trace";

import {
  hashLearnLoopStudyPlan,
  parseLearnLoopStudyPlan,
  type LearnLoopStudyPlan,
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
const studySplits = ["training", "evaluation"] as const;
const maximumTaskFamilies = 1_000;
const maximumUiVariantsPerTask = 64;
const maximumParticipants = 5_000;
const maximumInputBytes = 8 * 1024 * 1024;

export type LearnLoopStudySplit = (typeof studySplits)[number];

export interface LearnLoopStudyTaskFamily {
  taskHash: string;
  split: LearnLoopStudySplit;
  language: string;
  expectedStage: LearnLoopStudyStage;
  uiVariantHashes: string[];
}

export interface LearnLoopStudyTaskManifest {
  schemaVersion: "lhic-learnloop-study-task-manifest-v1";
  planSha256: string;
  manifestId: string;
  frozenAt: string;
  rubricVersion: string;
  randomizationSeedSha256: string;
  access: "restricted-coordinator";
  containsGoldLabels: true;
  taskFamilies: LearnLoopStudyTaskFamily[];
}

export interface LearnLoopStudyParticipantEnrollment {
  schemaVersion: "lhic-learnloop-study-participant-v1";
  planSha256: string;
  participantHash: string;
  split: LearnLoopStudySplit;
  language: string;
  enrolledAt: string;
  consented: true;
  withdrawn: false;
}

export interface LearnLoopStudyAssignment {
  participantHash: string;
  split: LearnLoopStudySplit;
  language: string;
  sequence: number;
  taskHash: string;
  uiVariantHash: string;
}

export interface LearnLoopStudySchedule {
  schemaVersion: "lhic-learnloop-study-schedule-v1";
  planSha256: string;
  manifestSha256: string;
  participantDatasetSha256: string;
  assignmentDatasetSha256: string;
  randomizationSeedSha256: string;
  access: "restricted-coordinator";
  containsGoldLabels: false;
  containsModelOutputs: false;
  counts: {
    participants: number;
    trainingParticipants: number;
    evaluationParticipants: number;
    assignments: number;
    trainingAssignments: number;
    evaluationAssignments: number;
    evaluationAssignmentsPerLanguage: Record<string, number>;
  };
  qualityChecks: {
    participantDisjoint: true;
    taskDisjoint: true;
    uiVariantDisjoint: true;
    requiredLanguageCoverage: true;
    minimumEvaluationUnits: true;
    expectedStageDiversity: true;
    maximumUiVariantImbalance: number;
  };
  assignments: LearnLoopStudyAssignment[];
  limitations: string[];
}

export function parseLearnLoopStudyTaskManifest(
  planInput: LearnLoopStudyPlan,
  value: unknown,
): LearnLoopStudyTaskManifest {
  const plan = parseLearnLoopStudyPlan(planInput);
  const manifest = exactRecord(
    value,
    [
      "schemaVersion",
      "planSha256",
      "manifestId",
      "frozenAt",
      "rubricVersion",
      "randomizationSeedSha256",
      "access",
      "containsGoldLabels",
      "taskFamilies",
    ],
    "study task manifest",
  );
  if (
    manifest.schemaVersion !== "lhic-learnloop-study-task-manifest-v1"
  ) {
    throw new Error("Study task manifest schemaVersion is unsupported.");
  }
  const planSha256 = sha256(manifest.planSha256, "planSha256");
  if (planSha256 !== hashLearnLoopStudyPlan(plan)) {
    throw new Error("Study task manifest is bound to a different plan.");
  }
  const frozenAt = canonicalTimestamp(manifest.frozenAt, "manifest frozenAt");
  if (Date.parse(frozenAt) < Date.parse(plan.frozenAt)) {
    throw new Error("Study task manifest predates the frozen plan.");
  }
  if (manifest.access !== "restricted-coordinator") {
    throw new Error("Study task manifest access must be restricted-coordinator.");
  }
  if (manifest.containsGoldLabels !== true) {
    throw new Error("Study task manifest must declare containsGoldLabels=true.");
  }
  if (!Array.isArray(manifest.taskFamilies)) {
    throw new Error("Study taskFamilies must be an array.");
  }
  if (
    manifest.taskFamilies.length < 2 ||
    manifest.taskFamilies.length > maximumTaskFamilies
  ) {
    throw new Error(
      `Study taskFamilies must contain 2-${maximumTaskFamilies} families.`,
    );
  }
  const taskFamilies = manifest.taskFamilies.map((family, index) =>
    parseTaskFamily(family, index, plan),
  );
  const taskHashes = new Set<string>();
  const uiVariantHashes = new Set<string>();
  for (const family of taskFamilies) {
    if (taskHashes.has(family.taskHash)) {
      throw new Error("Study task hashes must be globally unique.");
    }
    taskHashes.add(family.taskHash);
    for (const uiVariantHash of family.uiVariantHashes) {
      if (uiVariantHashes.has(uiVariantHash)) {
        throw new Error("Study UI variant hashes must be globally unique.");
      }
      uiVariantHashes.add(uiVariantHash);
    }
  }
  for (const split of studySplits) {
    if (!taskFamilies.some((family) => family.split === split)) {
      throw new Error(`Study task manifest must include ${split} tasks.`);
    }
  }
  for (const language of plan.requiredLanguages) {
    if (
      !taskFamilies.some(
        (family) =>
          family.split === "evaluation" && family.language === language,
      )
    ) {
      throw new Error(
        `Study task manifest lacks evaluation tasks for ${language}.`,
      );
    }
  }
  const evaluationStageCount = new Set(
    taskFamilies
      .filter((family) => family.split === "evaluation")
      .map((family) => family.expectedStage),
  ).size;
  if (
    evaluationStageCount < plan.thresholds.minimumDistinctExpectedStages
  ) {
    throw new Error(
      "Study task manifest cannot meet expected-stage diversity.",
    );
  }
  return {
    schemaVersion: "lhic-learnloop-study-task-manifest-v1",
    planSha256,
    manifestId: boundedIdentifier(manifest.manifestId, "manifestId", 128),
    frozenAt,
    rubricVersion: boundedIdentifier(
      manifest.rubricVersion,
      "rubricVersion",
      64,
    ),
    randomizationSeedSha256: sha256(
      manifest.randomizationSeedSha256,
      "randomizationSeedSha256",
    ),
    access: "restricted-coordinator",
    containsGoldLabels: true,
    taskFamilies,
  };
}

export function hashLearnLoopStudyTaskManifest(
  planInput: LearnLoopStudyPlan,
  manifestInput: LearnLoopStudyTaskManifest,
): string {
  return hashState(parseLearnLoopStudyTaskManifest(planInput, manifestInput));
}

export function parseLearnLoopStudyParticipants(
  planInput: LearnLoopStudyPlan,
  value: unknown,
): LearnLoopStudyParticipantEnrollment[] {
  const plan = parseLearnLoopStudyPlan(planInput);
  if (!Array.isArray(value)) {
    throw new Error("Study participants must be an array.");
  }
  if (value.length < 2 || value.length > maximumParticipants) {
    throw new Error(
      `Study participants must contain 2-${maximumParticipants} records.`,
    );
  }
  const planSha256 = hashLearnLoopStudyPlan(plan);
  const participants = value.map((participant, index) => {
    const row = exactRecord(
      participant,
      [
        "schemaVersion",
        "planSha256",
        "participantHash",
        "split",
        "language",
        "enrolledAt",
        "consented",
        "withdrawn",
      ],
      `study participant ${index}`,
    );
    if (row.schemaVersion !== "lhic-learnloop-study-participant-v1") {
      throw new Error(`Study participant ${index} schemaVersion is unsupported.`);
    }
    if (sha256(row.planSha256, `participant ${index} planSha256`) !== planSha256) {
      throw new Error(`Study participant ${index} is bound to a different plan.`);
    }
    if (row.consented !== true || row.withdrawn !== false) {
      throw new Error(
        `Study participant ${index} must be consented and not withdrawn.`,
      );
    }
    const language = languageTag(row.language, `participant ${index} language`);
    if (!plan.requiredLanguages.includes(language)) {
      throw new Error(
        `Study participant ${index} language is not preregistered.`,
      );
    }
    const enrolledAt = canonicalTimestamp(
      row.enrolledAt,
      `participant ${index} enrolledAt`,
    );
    if (Date.parse(enrolledAt) < Date.parse(plan.frozenAt)) {
      throw new Error(`Study participant ${index} predates the frozen plan.`);
    }
    return {
      schemaVersion: "lhic-learnloop-study-participant-v1",
      planSha256,
      participantHash: sha256(
        row.participantHash,
        `participant ${index} participantHash`,
      ),
      split: stringChoice(
        row.split,
        studySplits,
        `participant ${index} split`,
      ),
      language,
      enrolledAt,
      consented: true,
      withdrawn: false,
    } satisfies LearnLoopStudyParticipantEnrollment;
  });
  const participantHashes = new Set<string>();
  for (const participant of participants) {
    if (participantHashes.has(participant.participantHash)) {
      throw new Error("Study participant hashes must be unique.");
    }
    participantHashes.add(participant.participantHash);
  }
  for (const split of studySplits) {
    if (!participants.some((participant) => participant.split === split)) {
      throw new Error(`Study participants must include the ${split} split.`);
    }
  }
  return participants;
}

export function buildLearnLoopStudySchedule(
  planInput: LearnLoopStudyPlan,
  manifestInput: LearnLoopStudyTaskManifest,
  participantsInput: LearnLoopStudyParticipantEnrollment[],
): LearnLoopStudySchedule {
  const plan = parseLearnLoopStudyPlan(planInput);
  const manifest = parseLearnLoopStudyTaskManifest(plan, manifestInput);
  const participants = parseLearnLoopStudyParticipants(plan, participantsInput);
  const orderedParticipants = [...participants].sort((left, right) =>
    participantOrderKey(manifest.randomizationSeedSha256, left).localeCompare(
      participantOrderKey(manifest.randomizationSeedSha256, right),
    ),
  );
  const usage = new Map<string, Map<string, number>>();
  const assignments: LearnLoopStudyAssignment[] = [];
  for (const participant of orderedParticipants) {
    const eligibleFamilies = manifest.taskFamilies
      .filter(
        (family) =>
          family.split === participant.split &&
          family.language === participant.language,
      )
      .sort((left, right) =>
        taskOrderKey(
          manifest.randomizationSeedSha256,
          participant.participantHash,
          left.taskHash,
        ).localeCompare(
          taskOrderKey(
            manifest.randomizationSeedSha256,
            participant.participantHash,
            right.taskHash,
          ),
        ),
      );
    if (eligibleFamilies.length === 0) {
      throw new Error(
        `Study participant ${participant.participantHash} has no eligible tasks.`,
      );
    }
    for (const [index, family] of eligibleFamilies.entries()) {
      const familyUsage = usage.get(family.taskHash) ?? new Map<string, number>();
      usage.set(family.taskHash, familyUsage);
      const uiVariantHash = [...family.uiVariantHashes].sort((left, right) => {
        const countDifference =
          (familyUsage.get(left) ?? 0) - (familyUsage.get(right) ?? 0);
        if (countDifference !== 0) return countDifference;
        return variantOrderKey(
          manifest.randomizationSeedSha256,
          participant.participantHash,
          family.taskHash,
          left,
        ).localeCompare(
          variantOrderKey(
            manifest.randomizationSeedSha256,
            participant.participantHash,
            family.taskHash,
            right,
          ),
        );
      })[0]!;
      familyUsage.set(uiVariantHash, (familyUsage.get(uiVariantHash) ?? 0) + 1);
      assignments.push({
        participantHash: participant.participantHash,
        split: participant.split,
        language: participant.language,
        sequence: index + 1,
        taskHash: family.taskHash,
        uiVariantHash,
      });
    }
  }
  const trainingAssignments = assignments.filter(
    (assignment) => assignment.split === "training",
  );
  const evaluationAssignments = assignments.filter(
    (assignment) => assignment.split === "evaluation",
  );
  if (evaluationAssignments.length < plan.minimumEvaluationUnits) {
    throw new Error("Study schedule cannot meet minimumEvaluationUnits.");
  }
  const evaluationAssignmentsPerLanguage = Object.fromEntries(
    [...plan.requiredLanguages]
      .sort()
      .map((language) => [
        language,
        evaluationAssignments.filter(
          (assignment) => assignment.language === language,
        ).length,
      ]),
  );
  for (const language of plan.requiredLanguages) {
    if (
      (evaluationAssignmentsPerLanguage[language] ?? 0) <
      plan.minimumEvaluationUnitsPerLanguage
    ) {
      throw new Error(
        `Study schedule cannot meet evaluation minimum for ${language}.`,
      );
    }
  }
  const scheduledEvaluationTaskHashes = new Set(
    evaluationAssignments.map((assignment) => assignment.taskHash),
  );
  const scheduledEvaluationStages = new Set(
    manifest.taskFamilies
      .filter((family) => scheduledEvaluationTaskHashes.has(family.taskHash))
      .map((family) => family.expectedStage),
  );
  if (
    scheduledEvaluationStages.size <
    plan.thresholds.minimumDistinctExpectedStages
  ) {
    throw new Error("Study schedule cannot meet expected-stage diversity.");
  }
  const maximumUiVariantImbalance = maximumVariantImbalance(
    manifest.taskFamilies,
    usage,
  );
  if (maximumUiVariantImbalance > 1) {
    throw new Error("Study schedule UI variants are not balanced.");
  }
  const stableParticipants = [...participants].sort((left, right) =>
    left.participantHash.localeCompare(right.participantHash),
  );
  const stableAssignments = [...assignments].sort((left, right) =>
    assignmentSortKey(left).localeCompare(assignmentSortKey(right)),
  );
  return {
    schemaVersion: "lhic-learnloop-study-schedule-v1",
    planSha256: manifest.planSha256,
    manifestSha256: hashLearnLoopStudyTaskManifest(plan, manifest),
    participantDatasetSha256: hashState(stableParticipants),
    assignmentDatasetSha256: hashState(stableAssignments),
    randomizationSeedSha256: manifest.randomizationSeedSha256,
    access: "restricted-coordinator",
    containsGoldLabels: false,
    containsModelOutputs: false,
    counts: {
      participants: participants.length,
      trainingParticipants: participants.filter(
        (participant) => participant.split === "training",
      ).length,
      evaluationParticipants: participants.filter(
        (participant) => participant.split === "evaluation",
      ).length,
      assignments: assignments.length,
      trainingAssignments: trainingAssignments.length,
      evaluationAssignments: evaluationAssignments.length,
      evaluationAssignmentsPerLanguage,
    },
    qualityChecks: {
      participantDisjoint: true,
      taskDisjoint: true,
      uiVariantDisjoint: true,
      requiredLanguageCoverage: true,
      minimumEvaluationUnits: true,
      expectedStageDiversity: true,
      maximumUiVariantImbalance,
    },
    assignments: stableAssignments,
    limitations: [
      "The schedule contains participant pseudonyms and must remain restricted to the study coordinator.",
      "The schedule omits gold labels and model outputs, but operational blinding still depends on access control and task presentation outside this repository.",
      "Deterministic balancing prevents post-hoc assignment changes only when the manifest, participant dataset, and resulting digests are frozen before outcomes are inspected.",
    ],
  };
}

export async function readLearnLoopStudyTaskManifest(
  plan: LearnLoopStudyPlan,
  inputFile: string,
): Promise<LearnLoopStudyTaskManifest> {
  return parseLearnLoopStudyTaskManifest(
    plan,
    await readJson(inputFile, "Study task manifest"),
  );
}

export async function readLearnLoopStudyParticipants(
  plan: LearnLoopStudyPlan,
  inputFile: string,
): Promise<LearnLoopStudyParticipantEnrollment[]> {
  return parseLearnLoopStudyParticipants(
    plan,
    await readJsonLines(inputFile, "Study participants"),
  );
}

export async function writeLearnLoopStudySchedule(
  outputFile: string,
  schedule: LearnLoopStudySchedule,
): Promise<void> {
  const resolvedOutputFile = resolve(outputFile);
  await mkdir(dirname(resolvedOutputFile), { recursive: true });
  await writeFile(
    resolvedOutputFile,
    `${JSON.stringify(schedule, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
    },
  );
}

function parseTaskFamily(
  value: unknown,
  index: number,
  plan: LearnLoopStudyPlan,
): LearnLoopStudyTaskFamily {
  const family = exactRecord(
    value,
    ["taskHash", "split", "language", "expectedStage", "uiVariantHashes"],
    `study task family ${index}`,
  );
  const language = languageTag(family.language, `task family ${index} language`);
  if (!plan.requiredLanguages.includes(language)) {
    throw new Error(`Study task family ${index} language is not preregistered.`);
  }
  if (!Array.isArray(family.uiVariantHashes)) {
    throw new Error(`Study task family ${index} uiVariantHashes must be an array.`);
  }
  if (
    family.uiVariantHashes.length < 1 ||
    family.uiVariantHashes.length > maximumUiVariantsPerTask
  ) {
    throw new Error(
      `Study task family ${index} must contain 1-${maximumUiVariantsPerTask} UI variants.`,
    );
  }
  const uiVariantHashes = family.uiVariantHashes.map((hash, variantIndex) =>
    sha256(hash, `task family ${index} uiVariantHashes[${variantIndex}]`),
  );
  if (new Set(uiVariantHashes).size !== uiVariantHashes.length) {
    throw new Error(`Study task family ${index} UI variants must be unique.`);
  }
  return {
    taskHash: sha256(family.taskHash, `task family ${index} taskHash`),
    split: stringChoice(family.split, studySplits, `task family ${index} split`),
    language,
    expectedStage: stringChoice(
      family.expectedStage,
      studyStages,
      `task family ${index} expectedStage`,
    ),
    uiVariantHashes,
  };
}

function maximumVariantImbalance(
  taskFamilies: LearnLoopStudyTaskFamily[],
  usage: Map<string, Map<string, number>>,
): number {
  let maximum = 0;
  for (const family of taskFamilies) {
    const familyUsage = usage.get(family.taskHash) ?? new Map<string, number>();
    const counts = family.uiVariantHashes.map(
      (variant) => familyUsage.get(variant) ?? 0,
    );
    maximum = Math.max(maximum, Math.max(...counts) - Math.min(...counts));
  }
  return maximum;
}

function participantOrderKey(
  seed: string,
  participant: LearnLoopStudyParticipantEnrollment,
): string {
  return hashState({
    seed,
    participantHash: participant.participantHash,
    split: participant.split,
    language: participant.language,
  });
}

function taskOrderKey(
  seed: string,
  participantHash: string,
  taskHash: string,
): string {
  return hashState({ seed, participantHash, taskHash });
}

function variantOrderKey(
  seed: string,
  participantHash: string,
  taskHash: string,
  uiVariantHash: string,
): string {
  return hashState({ seed, participantHash, taskHash, uiVariantHash });
}

function assignmentSortKey(assignment: LearnLoopStudyAssignment): string {
  return `${assignment.participantHash}:${String(assignment.sequence).padStart(6, "0")}:${assignment.taskHash}:${assignment.uiVariantHash}`;
}

async function readJson(inputFile: string, name: string): Promise<unknown> {
  const content = await readBoundedText(inputFile, name);
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error(`${name} must be valid JSON.`);
  }
}

async function readJsonLines(
  inputFile: string,
  name: string,
): Promise<unknown[]> {
  const content = await readBoundedText(inputFile, name);
  if (content.trim().length === 0) return [];
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        throw new Error(`${name} line ${index + 1} must be valid JSON.`);
      }
    });
}

async function readBoundedText(inputFile: string, name: string): Promise<string> {
  const content = await readFile(resolve(inputFile), "utf8");
  if (Buffer.byteLength(content, "utf8") > maximumInputBytes) {
    throw new Error(`${name} exceeds ${maximumInputBytes} bytes.`);
  }
  return content;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error(`${name} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${name} must contain exactly: ${keys.join(", ")}.`);
  }
  return record;
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

function boundedIdentifier(
  value: unknown,
  name: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumLength ||
    !/^[A-Za-z0-9._:-]+$/u.test(value)
  ) {
    throw new Error(`${name} must be a bounded identifier.`);
  }
  return value;
}

function languageTag(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value)
  ) {
    throw new Error(`${name} must be a valid language tag.`);
  }
  return value;
}

function stringChoice<const Value extends string>(
  value: unknown,
  choices: readonly Value[],
  name: string,
): Value {
  if (typeof value !== "string" || !choices.includes(value as Value)) {
    throw new Error(`${name} is unsupported.`);
  }
  return value as Value;
}
