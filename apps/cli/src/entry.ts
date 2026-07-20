#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runCli as runLegacyCli } from "./main.js";
import { cliUsage } from "./interactive.js";
import { parseMcpHarness } from "./mcp-harness-config.js";
import {
  formatDoctorReport,
  formatSetupReport,
  formatSkillProgress,
  listSkillProgress,
  runUserDoctor,
  runUserSetup,
} from "./user-experience.js";

export const userCliUsage = `${cliUsage}\n\nBeginner commands:\n  lhic setup [codex|claude-code|vscode|antigravity] [workspace-root] [memory-database]\n  lhic doctor [memory-database]\n  lhic skills [memory-database]`;

/**
 * Backward-compatible public CLI entrypoint. Existing commands are delegated to
 * the original dispatcher; beginner commands are handled here so they can stay
 * small, readable, and independently tested.
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
