/**
 * Deterministic synthetic failure-injection harness.
 *
 * This is NOT an official OSWorld/SWE-bench/tau-bench result. It exists to
 * compare execution semantics under controlled non-atomic failures.
 */

interface TrialResult {
  taskSuccess: boolean;
  duplicateSideEffects: number;
  falseSuccess: boolean;
  humanResolution: boolean;
}

type FailureMode =
  | "none"
  | "crash_before_effect"
  | "crash_after_effect_before_response"
  | "delayed_visibility"
  | "inconclusive_observation";

type Strategy = "vanilla" | "verifier_only" | "ledger_only" | "full_lhic_core";

function runTrial(strategy: Strategy, mode: FailureMode): TrialResult {
  let effects = 0;
  let responseReceived = true;
  let firstObservation: "present" | "absent" | "inconclusive" = "present";

  switch (mode) {
    case "none":
      effects = 1;
      break;
    case "crash_before_effect":
      responseReceived = false;
      firstObservation = "absent";
      break;
    case "crash_after_effect_before_response":
      effects = 1;
      responseReceived = false;
      firstObservation = "present";
      break;
    case "delayed_visibility":
      effects = 1;
      responseReceived = false;
      firstObservation = "absent";
      break;
    case "inconclusive_observation":
      effects = 1;
      responseReceived = false;
      firstObservation = "inconclusive";
      break;
  }

  if (responseReceived) {
    return { taskSuccess: true, duplicateSideEffects: 0, falseSuccess: false, humanResolution: false };
  }

  if (strategy === "vanilla") {
    effects += 1;
    return {
      taskSuccess: true,
      duplicateSideEffects: Math.max(0, effects - 1),
      falseSuccess: false,
      humanResolution: false,
    };
  }

  if (strategy === "verifier_only") {
    if (firstObservation !== "present") effects += 1;
    return {
      taskSuccess: true,
      duplicateSideEffects: Math.max(0, effects - 1),
      falseSuccess: false,
      humanResolution: false,
    };
  }

  if (strategy === "ledger_only") {
    return {
      taskSuccess: mode !== "crash_before_effect",
      duplicateSideEffects: 0,
      falseSuccess: false,
      humanResolution: true,
    };
  }

  if (mode === "crash_before_effect") {
    effects += 1;
    return { taskSuccess: true, duplicateSideEffects: 0, falseSuccess: false, humanResolution: false };
  }
  if (mode === "crash_after_effect_before_response") {
    return { taskSuccess: true, duplicateSideEffects: 0, falseSuccess: false, humanResolution: false };
  }
  if (mode === "delayed_visibility") {
    return { taskSuccess: true, duplicateSideEffects: 0, falseSuccess: false, humanResolution: false };
  }
  return { taskSuccess: false, duplicateSideEffects: 0, falseSuccess: false, humanResolution: true };
}

const modes: FailureMode[] = [
  "none",
  "crash_before_effect",
  "crash_after_effect_before_response",
  "delayed_visibility",
  "inconclusive_observation",
];
const strategies: Strategy[] = ["vanilla", "verifier_only", "ledger_only", "full_lhic_core"];

for (const strategy of strategies) {
  const results = Array.from({ length: 100 }, (_, i) => runTrial(strategy, modes[i % modes.length]!));
  const avg = (fn: (r: TrialResult) => number) =>
    results.reduce((sum, result) => sum + fn(result), 0) / results.length;

  console.log(
    JSON.stringify({
      strategy,
      trials: results.length,
      taskSuccessRate: avg((r) => Number(r.taskSuccess)),
      duplicateSideEffectsPerTrial: avg((r) => r.duplicateSideEffects),
      falseSuccessRate: avg((r) => Number(r.falseSuccess)),
      humanResolutionRate: avg((r) => Number(r.humanResolution)),
    }),
  );
}
