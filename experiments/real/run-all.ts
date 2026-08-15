import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SurfaceExperimentResult } from "./common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const nodeArgs = ["--experimental-strip-types"];

interface Command {
  surface: SurfaceExperimentResult["surface"];
  command: string;
  args: string[];
}

const commands: Command[] = [
  {
    surface: "browser",
    command: node,
    args: [...nodeArgs, join(here, "browser.ts")],
  },
  {
    surface: "desktop",
    command: "xvfb-run",
    args: ["-a", node, ...nodeArgs, join(here, "desktop.ts")],
  },
  {
    surface: "code",
    command: node,
    args: [...nodeArgs, join(here, "code.ts")],
  },
];

function run(command: Command): SurfaceExperimentResult {
  const result = spawnSync(command.command, command.args, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
  });

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command.surface} experiment failed with status ${result.status}.`);
  }

  const line = (result.stdout ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("LHIC_REAL_RESULT="));
  if (!line) throw new Error(`${command.surface} experiment did not emit LHIC_REAL_RESULT.`);

  return JSON.parse(line.slice("LHIC_REAL_RESULT=".length)) as SurfaceExperimentResult;
}

function acceptanceErrors(results: SurfaceExperimentResult[]): string[] {
  const errors: string[] = [];
  for (const result of results) {
    if (result.baselineDuplicateSideEffects !== result.trials) {
      errors.push(
        `${result.surface}: baseline must demonstrate exactly one duplicate per trial; got ${result.baselineDuplicateSideEffects}/${result.trials}.`,
      );
    }
    if (result.lhicDuplicateSideEffects !== 0) {
      errors.push(`${result.surface}: LHIC produced ${result.lhicDuplicateSideEffects} duplicate side effects.`);
    }
    if (result.recoverySuccesses !== result.trials) {
      errors.push(
        `${result.surface}: only ${result.recoverySuccesses}/${result.trials} trials recovered to verified without replay.`,
      );
    }

    for (const trial of result.results) {
      if (trial.baseline.sideEffects !== 2 || trial.baseline.duplicateSideEffects !== 1) {
        errors.push(
          `${result.surface} trial ${trial.trial}: baseline did not execute the committed side effect twice.`,
        );
      }
      if (
        trial.lhic.sideEffects !== 1 ||
        trial.lhic.duplicateSideEffects !== 0 ||
        trial.lhic.firstState !== "possibly_committed" ||
        trial.lhic.recoveredState !== "verified" ||
        trial.lhic.dispatches !== 1 ||
        trial.lhic.observations !== 1 ||
        trial.lhic.verifications !== 1
      ) {
        errors.push(
          `${result.surface} trial ${trial.trial}: LHIC acceptance invariant failed ` +
            `(effects=${trial.lhic.sideEffects}, duplicates=${trial.lhic.duplicateSideEffects}, ` +
            `first=${trial.lhic.firstState}, recovered=${trial.lhic.recoveredState}, ` +
            `dispatches=${trial.lhic.dispatches}, observations=${trial.lhic.observations}, ` +
            `verifications=${trial.lhic.verifications}).`,
        );
      }
    }
  }
  return errors;
}

const results = commands.map(run);
const aggregate = {
  schemaVersion: "lhic-real-failure-injection-suite-v1",
  generatedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    trialsPerSurface: Number.parseInt(process.env.LHIC_REAL_TRIALS ?? "3", 10),
  },
  failure: "effect committed, dispatcher crashes before agent receives completion",
  surfaces: results,
  totals: {
    baselineDuplicateSideEffects: results.reduce(
      (sum, result) => sum + result.baselineDuplicateSideEffects,
      0,
    ),
    lhicDuplicateSideEffects: results.reduce(
      (sum, result) => sum + result.lhicDuplicateSideEffects,
      0,
    ),
    recoverySuccesses: results.reduce(
      (sum, result) => sum + result.recoverySuccesses,
      0,
    ),
    totalTrials: results.reduce((sum, result) => sum + result.trials, 0),
  },
};

const artifact = join(process.cwd(), "artifacts", "real-failure-injection-results.json");
await mkdir(dirname(artifact), { recursive: true });
await writeFile(artifact, `${JSON.stringify(aggregate, null, 2)}\n`, "utf8");

console.log("LHIC_REAL_SUITE=" + JSON.stringify(aggregate));
console.log(`Wrote ${artifact}`);

const errors = acceptanceErrors(results);
if (errors.length > 0) {
  throw new Error(`Real failure-injection acceptance gate failed:\n- ${errors.join("\n- ")}`);
}
