#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli as runLegacyCli } from "./main.js";
import { cliUsage } from "./interactive.js";
import { runLearnLoopBenchmark } from "./learnloop-benchmark.js";
import { parseMcpHarness } from "./mcp-harness-config.js";
import {
  formatDoctorReport,
  formatSetupReport,
  formatSkillProgress,
  listSkillProgress,
  runUserDoctor,
  runUserSetup,
} from "./user-experience.js";

export const userCliUsage = `${cliUsage}\n\nBeginner commands:\n  lhic setup [codex|claude-code|vscode|antigravity] [workspace-root] [memory-database]\n  lhic doctor [memory-database]\n  lhic skills [memory-database]\n\nXTF research command:\n  lhic bench learnloop [--output <path>]`;

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
