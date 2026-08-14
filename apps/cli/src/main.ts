#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readTraceEvents,
  summarizeTraceEvents,
  readReceipts,
} from "@lhic/trace";
import { inspectGlobalControlCapability } from "@lhic/skills";

import { runInternalBenchmark } from "./internal-benchmark.js";
import { runJudgeDemo } from "./demo.js";
import { runCapabilitiesCommand } from "./capabilities.js";
import {
  runBenchmarkEvidenceSign,
  runBenchmarkEvidenceValidate,
} from "./benchmark-evidence.js";
import { runDesktopObservationBenchmarkCommand } from "./desktop-observation-benchmark.js";
import { provenanceJson, renderProvenance } from "./provenance.js";
import { runVerifyCodingCommand } from "./verify-coding.js";
import { parseDemoCommandOptions } from "./demo-command-options.js";
import { startGuiCompanion } from "./gui-companion.js";
import { parseGuiCommandOptions } from "./gui-command-options.js";
import { runInteractiveDemo } from "./interactive-demo.js";
import {
  readExternalBenchmarkEvidence,
  validateExternalBenchmarkEvidence,
} from "./external-benchmark-evidence.js";
import {
  readCompetitiveBenchmarkEvidence,
  validateCompetitiveBenchmarkEvidence,
} from "./competitive-benchmark-evidence.js";
import {
  checkExternalBenchmarkReadiness,
  parseExternalBenchmarkTarget,
} from "./external-benchmark-readiness.js";
import {
  parseMcpHarness,
  renderMcpHarnessConfig,
} from "./mcp-harness-config.js";
import { runPreflight } from "./preflight.js";
import { runActionFile } from "./run-action.js";
import {
  parseBrowserPlanRunArguments,
  runBrowserPlanInteractively,
  runBrowserPlanFile,
} from "./run-plan.js";
import { runSelectorResilienceSimulation } from "./selector-resilience-simulation.js";
import { runSharedCommand } from "./shared-skills.js";
import { startLocalRuntime } from "./start.js";
import {
  parsePublicWebTrainingOptions,
  runPublicWebTraining,
} from "./public-web-training.js";
import { runGameTrainingCommand } from "./game-training.js";
import { runAgentCommand } from "./agent/agent-cli.js";
import type { OmpVersionPolicy } from "./agent/omp-binary.js";
import { installCliRuntime, installDesktopApplication } from "./installer.js";
import {
  cliUsage,
  createTerminalPrompter,
  guideCliArguments,
} from "./interactive.js";

export async function runCli(argumentsList: string[]): Promise<void> {
  if (isHelpRequest(argumentsList[0])) {
    console.log(cliUsage);
    return;
  }
  const prompter = createTerminalPrompter();
  try {
    await runGuidedCli(argumentsList, prompter);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "LHIC failed.");
    process.exitCode = 1;
  } finally {
    prompter.close();
  }
}

async function runGuidedCli(
  argumentsList: string[],
  prompter: ReturnType<typeof createTerminalPrompter>,
): Promise<void> {
  const guidedArguments = await guideCliArguments(argumentsList, prompter);
  await runCommand(guidedArguments, prompter);
}

async function runCommand(
  argumentsList: string[],
  prompter: ReturnType<typeof createTerminalPrompter>,
): Promise<void> {
  const [command, subcommand, argument] = argumentsList;
  if (command === "agent") {
    const parsed = parseAgentCommandOptions(argumentsList.slice(1));
    const exitCode = await runAgentCommand({
      ...(parsed.prompt ? { prompt: parsed.prompt } : {}),
      ...(parsed.session ? { session: parsed.session } : {}),
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.thinking ? { thinking: parsed.thinking } : {}),
      ...(parsed.subagentModels
        ? { subagentModels: parsed.subagentModels }
        : {}),
      ...(parsed.fast ? { fast: true } : {}),
      ...(parsed.jsonl ? { jsonl: true } : {}),
      ...(parsed.ompPolicy ? { ompPolicy: parsed.ompPolicy } : {}),
      approvalPolicy: parsed.approvalPolicy,
      ...(process.env.LHIC_AGENT_SESSION_DIR
        ? { sessionDir: process.env.LHIC_AGENT_SESSION_DIR }
        : {}),
    });
    process.exitCode = exitCode;
    return;
  }
  if (command === "start") {
    const result = await startLocalRuntime(subcommand);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "install" && subcommand === "cli") {
    const result = await installCliRuntime();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "install" && subcommand === "desktop") {
    const result = await installDesktopApplication();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "demo") {
    const demoOptions = parseDemoCommandOptions(argumentsList.slice(1));
    if (!demoOptions.safe) {
      await runInteractiveDemo(prompter, {
        ...(demoOptions.endpoint === undefined
          ? {}
          : { endpoint: demoOptions.endpoint }),
      });
      return;
    }
    if (demoOptions.viewable && !prompter.interactive) {
      throw new Error(
        "demo --safe --viewable requires an interactive terminal.",
      );
    }
    const report = await runJudgeDemo({
      viewable: demoOptions.viewable,
      ...(demoOptions.viewable
        ? {
            waitForClose: async () => {
              await prompter.prompt(
                "Safe demo is visible. Press Enter to close the browser",
              );
            },
          }
        : {}),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "gui") {
    const guiOptions = parseGuiCommandOptions(argumentsList.slice(1));
    const companion = await startGuiCompanion({
      initialTab: guiOptions.initialTab,
      ...(guiOptions.openBrowser ? {} : { openBrowser: async () => undefined }),
    });
    console.log(`LHIC GUI Companion: ${companion.url}`);
    console.log("Keep this terminal open while using the local companion.");
    return;
  }
  if (command === "shared") {
    const result = await runSharedCommand(subcommand, argumentsList.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.lastError) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "train" && subcommand === "public-web") {
    const result = await runPublicWebTraining(
      parsePublicWebTrainingOptions(argumentsList.slice(2)),
    );
    console.log(JSON.stringify(result, null, 2));
    if (result.sharedSkills.enabled && result.sharedSkills.lastError) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "train" && subcommand === "game") {
    const result = await runGameTrainingCommand(argumentsList.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.passed === false) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "preflight") {
    const report = await runPreflight();
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "global" && subcommand === "doctor") {
    const report = await inspectGlobalControlCapability();
    console.log(JSON.stringify(report, null, 2));
    if (!report.supported) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "run" && subcommand === "action" && argument) {
    const approvalFilePath = argumentsList[3];
    const result = await runActionFile(argument, approvalFilePath);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "run" && subcommand === "plan" && argument) {
    const result = await (prompter.interactive
      ? runBrowserPlanInteractively(
          argument,
          prompter,
          parseBrowserPlanRunArguments(argumentsList.slice(3)),
        )
      : runBrowserPlanFile(
          argument,
          parseBrowserPlanRunArguments(argumentsList.slice(3)),
        ));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "completed") {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "bench" && subcommand === "internal") {
    const report = await runInternalBenchmark();
    const outputFile = parseOutputFile(argumentsList);
    if (outputFile) {
      await writeBenchmarkOutput(outputFile, report);
    }
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }
  if (
    command === "bench" &&
    subcommand === "simulate" &&
    argument === "resilience"
  ) {
    const taskCount = parseIntegerArgument(argumentsList[3], "task count");
    const seed = parseIntegerArgument(argumentsList[4], "seed");
    const report = await runSelectorResilienceSimulation({
      ...(taskCount === undefined ? {} : { taskCount }),
      ...(seed === undefined ? {} : { seed }),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (command === "bench" && subcommand === "readiness") {
    const target = parseExternalBenchmarkTarget(argument);
    if (!target) {
      throw new Error("Benchmark target must be workarena or webarena.");
    }
    const report = checkExternalBenchmarkReadiness(target);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "bench" && subcommand === "validate-evidence" && argument) {
    const evidence = await readExternalBenchmarkEvidence(argument);
    const result = validateExternalBenchmarkEvidence(evidence);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) {
      process.exitCode = 1;
    }
    return;
  }
  if (
    command === "bench" &&
    subcommand === "validate-competitive" &&
    argument
  ) {
    const comparator = argumentsList[4];
    if (comparator !== "goose" && comparator !== "codex") {
      throw new Error("Competitive comparator must be goose or codex.");
    }
    const evidence = await readCompetitiveBenchmarkEvidence(argument);
    const result = validateCompetitiveBenchmarkEvidence(evidence, comparator);
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "mcp" && subcommand === "config") {
    const harness = parseMcpHarness(argument);
    if (!harness) {
      throw new Error(
        "MCP harness must be antigravity, codex, claude-code, or vscode.",
      );
    }
    console.log(
      renderMcpHarnessConfig(harness, argumentsList[3] ?? process.cwd()),
    );
    return;
  }
  if (command === "trace" && subcommand === "inspect" && argument) {
    const events = await readTraceEvents(argument);
    console.log(
      JSON.stringify(
        { file: argument, summary: summarizeTraceEvents(events) },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "trace" && subcommand === "provenance" && argument) {
    const receipts = await readReceipts(argument);
    const json = argumentsList.includes("--json");
    console.log(json ? provenanceJson(receipts) : renderProvenance(receipts));
    return;
  }
  if (command === "capabilities") {
    const exitCode = await runCapabilitiesCommand();
    process.exitCode = exitCode;
    return;
  }
  if (command === "verify" && subcommand === "coding") {
    const exitCode = await runVerifyCodingCommand(argumentsList.slice(2));
    process.exitCode = exitCode;
    return;
  }
  if (command === "bench" && subcommand === "evidence-sign") {
    const exitCode = await runBenchmarkEvidenceSign(argumentsList.slice(2));
    process.exitCode = exitCode;
    return;
  }
  if (command === "bench" && subcommand === "evidence-validate") {
    const exitCode = await runBenchmarkEvidenceValidate(argumentsList.slice(2));
    process.exitCode = exitCode;
    return;
  }
  if (command === "bench" && subcommand === "desktop-observation") {
    const exitCode = await runDesktopObservationBenchmarkCommand();
    process.exitCode = exitCode;
    return;
  }
  throw new Error(cliUsage);
}

export function parseAgentCommandOptions(argumentsList: string[]): {
  prompt?: string;
  session?: string;
  model?: string;
  thinking?: string;
  subagentModels?: string[];
  fast: boolean;
  jsonl: boolean;
  ompPolicy?: OmpVersionPolicy;
  approvalPolicy: "ask" | "deny" | "auto";
} {
  const result: {
    prompt?: string;
    session?: string;
    model?: string;
    thinking?: string;
    subagentModels?: string[];
    fast: boolean;
    jsonl: boolean;
    ompPolicy?: OmpVersionPolicy;
    approvalPolicy: "ask" | "deny" | "auto";
  } = {
    fast: false,
    jsonl: false,
    approvalPolicy: "ask",
  };
  const promptParts: string[] = [];
  let subagentModelsDisabled = false;
  let ompPolicyMode: "pinned" | "managed" | "development-latest" | undefined;
  let ompPolicyVersion: string | undefined;
  let ompPolicyDigest: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const value = argumentsList[index]!;
    const next = argumentsList[index + 1];
    if (value === "--jsonl") {
      result.jsonl = true;
      continue;
    }
    if (value === "--fast") {
      result.fast = true;
      continue;
    }
    if (value === "--subagent-model") {
      if (!next || next.startsWith("--")) {
        throw new Error("--subagent-model requires provider/id or none.");
      }
      result.subagentModels ??= [];
      if (next === "none") {
        if (result.subagentModels.length > 0 || subagentModelsDisabled) {
          throw new Error(
            "--subagent-model none cannot be combined with model selectors.",
          );
        }
        subagentModelsDisabled = true;
        result.subagentModels = [];
      } else {
        if (subagentModelsDisabled) {
          throw new Error(
            "--subagent-model none cannot be combined with model selectors.",
          );
        }
        result.subagentModels.push(next);
      }
      index += 1;
      continue;
    }
    if (
      value === "--session" ||
      value === "--model" ||
      value === "--thinking"
    ) {
      if (!next || next.startsWith("--")) {
        throw new Error(`${value} requires a value.`);
      }
      if (value === "--session") result.session = next;
      if (value === "--model") result.model = next;
      if (value === "--thinking") result.thinking = next;
      index += 1;
      continue;
    }
    if (value === "--approval-policy") {
      if (next !== "ask" && next !== "deny" && next !== "auto") {
        throw new Error("--approval-policy must be ask, deny, or auto.");
      }
      result.approvalPolicy = next;
      index += 1;
      continue;
    }
    if (value === "--omp-policy") {
      if (
        next !== "pinned" &&
        next !== "managed" &&
        next !== "development-latest"
      ) {
        throw new Error(
          "--omp-policy must be pinned, managed, or development-latest.",
        );
      }
      ompPolicyMode = next;
      index += 1;
      continue;
    }
    if (value === "--omp-version") {
      if (!next || next.startsWith("--")) {
        throw new Error("--omp-version requires a value.");
      }
      ompPolicyVersion = next;
      index += 1;
      continue;
    }
    if (value === "--omp-digest") {
      if (!next || !/^[a-f0-9]{64}$/.test(next)) {
        throw new Error("--omp-digest requires a 64-character hex SHA-256.");
      }
      ompPolicyDigest = next;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) {
      throw new Error(`Unknown agent option: ${value}.`);
    }
    promptParts.push(value);
  }
  if (promptParts.length > 0) result.prompt = promptParts.join(" ");
  if (result.jsonl && !result.prompt) {
    throw new Error("--jsonl requires a one-shot agent prompt.");
  }
  if (ompPolicyMode === "pinned") {
    if (!ompPolicyVersion) {
      throw new Error("--omp-policy pinned requires --omp-version.");
    }
    result.ompPolicy = {
      mode: "pinned",
      version: ompPolicyVersion,
      ...(ompPolicyDigest ? { digest: ompPolicyDigest } : {}),
    };
  } else if (ompPolicyMode) {
    if (ompPolicyVersion || ompPolicyDigest) {
      throw new Error(
        "--omp-version/--omp-digest require --omp-policy pinned.",
      );
    }
    result.ompPolicy = { mode: ompPolicyMode };
  } else if (ompPolicyVersion || ompPolicyDigest) {
    throw new Error("--omp-version/--omp-digest require --omp-policy pinned.");
  }
  return result;
}

function parseIntegerArgument(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer.`);
  }
  return parsed;
}

function parseOutputFile(argumentsList: string[]): string | undefined {
  if (argumentsList.length === 2) {
    return undefined;
  }
  if (
    argumentsList.length !== 4 ||
    argumentsList[2] !== "--output" ||
    !argumentsList[3]
  ) {
    throw new Error(
      "Internal benchmark accepts only --output <path> in addition to its command.",
    );
  }
  return argumentsList[3];
}

async function writeBenchmarkOutput(
  outputFile: string,
  report: Awaited<ReturnType<typeof runInternalBenchmark>>,
): Promise<void> {
  const resolvedOutputFile = resolve(outputFile);
  await mkdir(dirname(resolvedOutputFile), { recursive: true });
  await writeFile(resolvedOutputFile, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function isHelpRequest(command: string | undefined): boolean {
  return command === "help" || command === "--help" || command === "-h";
}

if (isCliEntryPoint()) {
  void runCli(process.argv.slice(2));
}

export function isCliEntryPoint(
  executablePath = process.argv[1],
  modulePath = fileURLToPath(import.meta.url),
): boolean {
  if (!executablePath) {
    return false;
  }
  try {
    return realpathSync(executablePath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
