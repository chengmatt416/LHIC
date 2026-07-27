#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli as runLegacyCli } from "./main.js";
import { cliUsage } from "./interactive.js";
import { runLearnLoopBenchmark } from "./learnloop-benchmark.js";
import {
  analyzeLearnLoopStudy,
  hashLearnLoopStudyPlan,
  readLearnLoopStudyPlan,
  readLearnLoopStudyRecords,
  writeLearnLoopStudyReport,
} from "./learnloop-study.js";
import {
  finalizeLearnLoopStudyLabels,
  readLearnLoopStudyAdjudications,
  readLearnLoopStudyAnnotations,
  readLearnLoopStudyBlindUnits,
  writeFinalizedLearnLoopStudyLabels,
} from "./learnloop-study-labeling.js";
import {
  buildLearnLoopStudySchedule,
  readLearnLoopStudyParticipants,
  readLearnLoopStudyTaskManifest,
  writeLearnLoopStudySchedule,
} from "./learnloop-study-schedule.js";
import {
  redactLearnLoopStudyParticipant,
  writeRedactedLearnLoopStudyData,
} from "./learnloop-study-withdrawal.js";
import { parseMcpHarness } from "./mcp-harness-config.js";
import {
  formatDoctorReport,
  formatSetupReport,
  formatSkillProgress,
  listSkillProgress,
  runUserDoctor,
  runUserSetup,
} from "./user-experience.js";

export const userCliUsage = `${cliUsage}\n\nBeginner commands:\n  lhic setup [codex|claude-code|vscode|antigravity] [workspace-root] [memory-database]\n  lhic doctor [memory-database]\n  lhic skills [memory-database]\n\nXTF research commands:\n  lhic bench learnloop [--output <path>]\n  lhic study learnloop digest --plan <plan.json>\n  lhic study learnloop schedule --plan <plan.json> --manifest <manifest.json> --participants <participants.jsonl> --output <schedule.json>\n  lhic study learnloop withdraw --units <units.jsonl> --annotations <annotations.jsonl> --adjudications <adjudications.jsonl> --participant-hash <sha256> --units-output <units.jsonl> --annotations-output <annotations.jsonl> --adjudications-output <adjudications.jsonl> --receipt-output <receipt.json>\n  lhic study learnloop finalize-labels --plan <plan.json> --units <units.jsonl> --annotations <annotations.jsonl> --adjudications <adjudications.jsonl> --records-output <records.jsonl> --report-output <label-report.json>\n  lhic study learnloop analyze --plan <plan.json> --records <records.jsonl> --output <report.json>`;

/**
 * Backward-compatible public CLI entrypoint. Existing commands are delegated to
 * the original dispatcher; beginner and research commands are handled here so
 * they can stay small, readable, and independently tested.
 */
export async function runCli(argumentsList: string[]): Promise<void> {
  const [command, firstArgument, workspaceRoot, databaseFile] = argumentsList;

  if (command === "help" || command === "--help" || command === "-h") {
    console.log(userCliUsage);
    return;
  }

  try {
    if (command === "setup") {
      const harness =
        firstArgument === undefined ? "codex" : parseMcpHarness(firstArgument);
      if (!harness) {
        throw new Error(
          "Setup client must be codex, claude-code, vscode, or antigravity.",
        );
      }
      const report = await runUserSetup({
        harness,
        ...(workspaceRoot ? { workspaceRoot } : {}),
        ...(databaseFile ? { databaseFile } : {}),
      });
      console.log(formatSetupReport(report));
      if (!report.ready) process.exitCode = 1;
      return;
    }

    if (command === "doctor") {
      const report = await runUserDoctor(firstArgument);
      console.log(formatDoctorReport(report));
      if (!report.ready) process.exitCode = 1;
      return;
    }

    if (command === "skills") {
      const progress = await listSkillProgress(firstArgument);
      console.log(formatSkillProgress(progress));
      return;
    }

    if (command === "bench" && firstArgument === "learnloop") {
      const report = runLearnLoopBenchmark();
      const outputFile = parseResearchOutput(argumentsList.slice(2));
      if (outputFile) await writeResearchOutput(outputFile, report);
      console.log(JSON.stringify(report, null, 2));
      if (!report.passed) process.exitCode = 1;
      return;
    }

    if (command === "study" && firstArgument === "learnloop") {
      const action = argumentsList[2];
      if (action === "digest") {
        const planFile = parseStudyDigestOptions(argumentsList.slice(3));
        const plan = await readLearnLoopStudyPlan(planFile);
        console.log(
          JSON.stringify(
            {
              schemaVersion: "lhic-learnloop-study-plan-digest-v1",
              planSha256: hashLearnLoopStudyPlan(plan),
            },
            null,
            2,
          ),
        );
        return;
      }
      if (action === "schedule") {
        const options = parseStudyScheduleOptions(argumentsList.slice(3));
        const plan = await readLearnLoopStudyPlan(options.planFile);
        const [manifest, participants] = await Promise.all([
          readLearnLoopStudyTaskManifest(plan, options.manifestFile),
          readLearnLoopStudyParticipants(plan, options.participantsFile),
        ]);
        const schedule = buildLearnLoopStudySchedule(
          plan,
          manifest,
          participants,
        );
        await writeLearnLoopStudySchedule(options.outputFile, schedule);
        console.log(JSON.stringify(schedule, null, 2));
        return;
      }
      if (action === "withdraw") {
        const options = parseStudyWithdrawalOptions(argumentsList.slice(3));
        const [units, annotations, adjudications] = await Promise.all([
          readLearnLoopStudyBlindUnits(options.unitsFile),
          readLearnLoopStudyAnnotations(options.annotationsFile),
          readLearnLoopStudyAdjudications(options.adjudicationsFile),
        ]);
        const redacted = redactLearnLoopStudyParticipant(
          units,
          annotations,
          adjudications,
          options.participantHash,
          new Date().toISOString(),
        );
        await writeRedactedLearnLoopStudyData(
          options.unitsOutputFile,
          options.annotationsOutputFile,
          options.adjudicationsOutputFile,
          options.receiptOutputFile,
          redacted,
        );
        console.log(JSON.stringify(redacted.receipt, null, 2));
        return;
      }
      if (action === "finalize-labels") {
        const options = parseStudyLabelingOptions(argumentsList.slice(3));
        const [plan, units, annotations, adjudications] = await Promise.all([
          readLearnLoopStudyPlan(options.planFile),
          readLearnLoopStudyBlindUnits(options.unitsFile),
          readLearnLoopStudyAnnotations(options.annotationsFile),
          readLearnLoopStudyAdjudications(options.adjudicationsFile),
        ]);
        const finalized = finalizeLearnLoopStudyLabels(
          plan,
          units,
          annotations,
          adjudications,
        );
        await writeFinalizedLearnLoopStudyLabels(
          options.recordsOutputFile,
          options.reportOutputFile,
          finalized,
        );
        console.log(JSON.stringify(finalized.report, null, 2));
        return;
      }
      if (action === "analyze") {
        const options = parseStudyAnalyzeOptions(argumentsList.slice(3));
        const [plan, records] = await Promise.all([
          readLearnLoopStudyPlan(options.planFile),
          readLearnLoopStudyRecords(options.recordsFile),
        ]);
        const report = analyzeLearnLoopStudy(plan, records);
        await writeLearnLoopStudyReport(options.outputFile, report);
        console.log(JSON.stringify(report, null, 2));
        if (!report.passed) process.exitCode = 1;
        return;
      }
      throw new Error(
        "LearnLoop study action must be digest, schedule, withdraw, finalize-labels, or analyze. Run `lhic help` for usage.",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "LHIC failed.");
    process.exitCode = 1;
    return;
  }

  if (argumentsList.length === 0 && process.stdout.isTTY) {
    console.log(
      "Tip: first-time users can run `lhic setup`; use `lhic doctor` when something is not working.\n",
    );
  }
  await runLegacyCli(argumentsList);
}

function parseResearchOutput(argumentsList: string[]): string | undefined {
  if (argumentsList.length === 0) return undefined;
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--output" ||
    !argumentsList[1]
  ) {
    throw new Error("LearnLoop benchmark accepts only --output <path>.");
  }
  return argumentsList[1];
}

function parseStudyDigestOptions(argumentsList: string[]): string {
  const options = parseExactFlags(argumentsList, ["--plan"]);
  return options["--plan"]!;
}

function parseStudyScheduleOptions(argumentsList: string[]): {
  planFile: string;
  manifestFile: string;
  participantsFile: string;
  outputFile: string;
} {
  const options = parseExactFlags(argumentsList, [
    "--plan",
    "--manifest",
    "--participants",
    "--output",
  ]);
  return {
    planFile: options["--plan"]!,
    manifestFile: options["--manifest"]!,
    participantsFile: options["--participants"]!,
    outputFile: options["--output"]!,
  };
}

function parseStudyWithdrawalOptions(argumentsList: string[]): {
  unitsFile: string;
  annotationsFile: string;
  adjudicationsFile: string;
  participantHash: string;
  unitsOutputFile: string;
  annotationsOutputFile: string;
  adjudicationsOutputFile: string;
  receiptOutputFile: string;
} {
  const options = parseExactFlags(argumentsList, [
    "--units",
    "--annotations",
    "--adjudications",
    "--participant-hash",
    "--units-output",
    "--annotations-output",
    "--adjudications-output",
    "--receipt-output",
  ]);
  return {
    unitsFile: options["--units"]!,
    annotationsFile: options["--annotations"]!,
    adjudicationsFile: options["--adjudications"]!,
    participantHash: options["--participant-hash"]!,
    unitsOutputFile: options["--units-output"]!,
    annotationsOutputFile: options["--annotations-output"]!,
    adjudicationsOutputFile: options["--adjudications-output"]!,
    receiptOutputFile: options["--receipt-output"]!,
  };
}

function parseStudyLabelingOptions(argumentsList: string[]): {
  planFile: string;
  unitsFile: string;
  annotationsFile: string;
  adjudicationsFile: string;
  recordsOutputFile: string;
  reportOutputFile: string;
} {
  const options = parseExactFlags(argumentsList, [
    "--plan",
    "--units",
    "--annotations",
    "--adjudications",
    "--records-output",
    "--report-output",
  ]);
  return {
    planFile: options["--plan"]!,
    unitsFile: options["--units"]!,
    annotationsFile: options["--annotations"]!,
    adjudicationsFile: options["--adjudications"]!,
    recordsOutputFile: options["--records-output"]!,
    reportOutputFile: options["--report-output"]!,
  };
}

function parseStudyAnalyzeOptions(argumentsList: string[]): {
  planFile: string;
  recordsFile: string;
  outputFile: string;
} {
  const options = parseExactFlags(argumentsList, [
    "--plan",
    "--records",
    "--output",
  ]);
  return {
    planFile: options["--plan"]!,
    recordsFile: options["--records"]!,
    outputFile: options["--output"]!,
  };
}

function parseExactFlags(
  argumentsList: string[],
  expectedFlags: readonly string[],
): Record<string, string> {
  if (argumentsList.length !== expectedFlags.length * 2) {
    throw new Error(
      `Expected exactly: ${expectedFlags.map((flag) => `${flag} <path>`).join(" ")}.`,
    );
  }
  const expected = new Set(expectedFlags);
  const options: Record<string, string> = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag || !expected.has(flag) || !value || options[flag]) {
      throw new Error(
        "Study command contains an unknown, duplicate, or empty flag.",
      );
    }
    options[flag] = value;
  }
  if (Object.keys(options).length !== expectedFlags.length) {
    throw new Error("Study command is missing a required flag.");
  }
  return options;
}

async function writeResearchOutput(
  outputFile: string,
  report: ReturnType<typeof runLearnLoopBenchmark>,
): Promise<void> {
  const resolvedOutputFile = resolve(outputFile);
  await mkdir(dirname(resolvedOutputFile), { recursive: true });
  await writeFile(resolvedOutputFile, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

if (isEntryPoint()) {
  void runCli(process.argv.slice(2));
}

export function isEntryPoint(
  executablePath = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
): boolean {
  if (!executablePath) return false;
  try {
    return realpathSync(executablePath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
