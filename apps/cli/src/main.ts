#!/usr/bin/env node

import { readTraceEvents, summarizeTraceEvents } from "@lhic/trace";

import { runInternalBenchmark } from "./internal-benchmark.js";
import {
  readExternalBenchmarkEvidence,
  validateExternalBenchmarkEvidence,
} from "./external-benchmark-evidence.js";
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
import { runSelectorResilienceSimulation } from "./selector-resilience-simulation.js";
import { startLocalRuntime } from "./start.js";

async function main(argumentsList: string[]): Promise<void> {
  const [command, subcommand, argument] = argumentsList;
  if (command === "start") {
    const result = await startLocalRuntime(subcommand);
    console.log(JSON.stringify(result, null, 2));
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
  if (command === "run" && subcommand === "action" && argument) {
    const approvalFilePath = argumentsList[3];
    const result = await runActionFile(argument, approvalFilePath);
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "bench" && subcommand === "internal") {
    const report = await runInternalBenchmark();
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
  console.error(
    "Usage: lhic start [memory-database] | lhic preflight | lhic run action <action-file> [approval-file] | lhic bench internal | lhic bench simulate resilience [task-count] [seed] | lhic bench readiness <workarena|webarena> | lhic bench validate-evidence <file> | lhic mcp config <antigravity|codex|claude-code|vscode> [workspace-root] | lhic trace inspect <trace-file>",
  );
  process.exitCode = 1;
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

void main(process.argv.slice(2));
