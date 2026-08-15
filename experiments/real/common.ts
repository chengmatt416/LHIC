import { createHash } from "node:crypto";
import type { ApprovalRecord, ResearchAction, VerificationEvidence } from "../../src/model.ts";

export interface SurfaceTrialResult {
  surface: "browser" | "desktop" | "code";
  trial: number;
  baseline: {
    sideEffects: number;
    duplicateSideEffects: number;
  };
  lhic: {
    sideEffects: number;
    duplicateSideEffects: number;
    firstState: string;
    recoveredState: string;
    dispatches: number;
    observations: number;
    verifications: number;
  };
}

export interface SurfaceExperimentResult {
  schemaVersion: "lhic-real-failure-injection-v1";
  surface: "browser" | "desktop" | "code";
  failure: "effect_committed_then_dispatcher_crash_before_agent_response";
  trials: number;
  baselineDuplicateSideEffects: number;
  lhicDuplicateSideEffects: number;
  recoverySuccesses: number;
  results: SurfaceTrialResult[];
}

export function exactApproval(action: ResearchAction, suffix = ""): ApprovalRecord {
  return {
    approvalId: `approval:${action.actionId}${suffix}`,
    approvedBy: "experiment-operator",
    authority: "operator",
    createdAt: new Date().toISOString(),
    scope: {
      type: "exact_action",
      actionHash: action.actionHash,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
  };
}

export function passedEvidence(
  evidenceId: string,
  condition: string,
  artifact: string | Buffer,
): VerificationEvidence {
  return {
    evidenceId,
    verifier: "lhic",
    condition,
    result: "passed",
    artifactHashes: [sha256(artifact)],
    createdAt: new Date().toISOString(),
  };
}

export function failedEvidence(
  evidenceId: string,
  condition: string,
  artifact: string | Buffer,
): VerificationEvidence {
  return {
    evidenceId,
    verifier: "lhic",
    condition,
    result: "failed",
    artifactHashes: [sha256(artifact)],
    createdAt: new Date().toISOString(),
  };
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function deterministicHash(label: string): string {
  return sha256(`lhic-core-real-experiment:${label}`);
}

export function trialCount(): number {
  const parsed = Number.parseInt(process.env.LHIC_REAL_TRIALS ?? "3", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 3;
}

export function summarize(
  surface: SurfaceExperimentResult["surface"],
  results: SurfaceTrialResult[],
): SurfaceExperimentResult {
  return {
    schemaVersion: "lhic-real-failure-injection-v1",
    surface,
    failure: "effect_committed_then_dispatcher_crash_before_agent_response",
    trials: results.length,
    baselineDuplicateSideEffects: results.reduce(
      (sum, result) => sum + result.baseline.duplicateSideEffects,
      0,
    ),
    lhicDuplicateSideEffects: results.reduce(
      (sum, result) => sum + result.lhic.duplicateSideEffects,
      0,
    ),
    recoverySuccesses: results.filter(
      (result) =>
        result.lhic.recoveredState === "verified" &&
        result.lhic.dispatches === 1 &&
        result.lhic.duplicateSideEffects === 0,
    ).length,
    results,
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms.`);
}
