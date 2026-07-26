import { randomUUID } from "node:crypto";

import type {
  NormalizedUIState,
  UserIntent,
  VerificationResult,
} from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { predictIntent, type IntentPrediction } from "./predictor.js";
import type { ControllerStage } from "./stage-classifier.js";

export type HumanIntentAdmission =
  | "execute_fast"
  | "require_confirmation"
  | "defer_to_slow_path";

export type LearnLoopRuleStatus =
  | "candidate"
  | "active"
  | "quarantined"
  | "revoked";

export interface LearnLoopRule {
  id: string;
  contextKey: string;
  fromStage: ControllerStage;
  toStage: ControllerStage;
  skillName?: string;
  status: LearnLoopRuleStatus;
  evidenceCount: number;
  taskIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface LearnLoopSnapshot {
  schemaVersion: "lhic-learnloop-v1";
  rules: LearnLoopRule[];
}

export interface VerifiedIntentCorrection {
  correctionId?: string;
  taskId: string;
  intent: UserIntent;
  uiState: NormalizedUIState;
  predictedStage: ControllerStage;
  correctedStage: ControllerStage;
  correctedSkillName?: string;
  confirmedByUser: boolean;
  verification: VerificationResult;
  recordedAt?: string;
}

export interface IntentDriftReport {
  detected: boolean;
  score: number;
  reasons: string[];
}

export interface HumanIntentDecision {
  admission: HumanIntentAdmission;
  reason: string;
  basePrediction: IntentPrediction;
  prediction: IntentPrediction;
  drift: IntentDriftReport;
  appliedRuleIds: string[];
  decisionLatencyMs: number;
}

export interface HumanIntentLearnLoopOptions {
  minimumEvidence?: number;
  maximumRules?: number;
  fastPathThreshold?: number;
  driftThreshold?: number;
  maximumSessions?: number;
}

interface SessionState {
  intentFingerprint: string;
  stages: ControllerStage[];
  confidence: number;
  updatedAt: number;
}

interface ContextFeatures {
  key: string;
  intentFingerprint: string;
}

const skillForStage: Partial<Record<ControllerStage, string>> = {
  login: "login",
  form_filling: "fill_form",
  search: "search",
  download: "download_file",
  test_web_flow: "test_web_flow",
};

/**
 * Prediction remains the authority: the base predictor runs first on every
 * request. LearnLoop may only re-rank to a known deterministic LHIC stage after
 * verifier-backed human corrections; it never emits actions or relaxes risk.
 */
export class HumanIntentLearnLoop {
  private readonly rules = new Map<string, LearnLoopRule>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly minimumEvidence: number;
  private readonly maximumRules: number;
  private readonly fastPathThreshold: number;
  private readonly driftThreshold: number;
  private readonly maximumSessions: number;

  public constructor(options: HumanIntentLearnLoopOptions = {}) {
    this.minimumEvidence = boundedInteger(
      options.minimumEvidence ?? 2,
      1,
      20,
      "minimumEvidence",
    );
    this.maximumRules = boundedInteger(
      options.maximumRules ?? 256,
      1,
      10_000,
      "maximumRules",
    );
    this.maximumSessions = boundedInteger(
      options.maximumSessions ?? 128,
      1,
      10_000,
      "maximumSessions",
    );
    this.fastPathThreshold = boundedProbability(
      options.fastPathThreshold ?? 0.8,
      "fastPathThreshold",
    );
    this.driftThreshold = boundedProbability(
      options.driftThreshold ?? 0.55,
      "driftThreshold",
    );
  }

  public decide(
    sessionId: string,
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): HumanIntentDecision {
    const startedAt = performance.now();
    const basePrediction = predictIntent(intent, uiState);
    const features = contextFeatures(intent, uiState);
    const learned = this.applyRules(features.key, basePrediction);
    const drift = this.detectDrift(
      sessionId,
      features.intentFingerprint,
      learned.prediction,
      learned.conflict,
      intent,
    );
    const admission = admitPrediction(intent, learned.prediction, drift, {
      fastPathThreshold: this.fastPathThreshold,
    });
    this.rememberSession(
      sessionId,
      features.intentFingerprint,
      learned.prediction,
    );
    return {
      admission: admission.admission,
      reason: admission.reason,
      basePrediction,
      prediction: learned.prediction,
      drift,
      appliedRuleIds: learned.appliedRuleIds,
      decisionLatencyMs: performance.now() - startedAt,
    };
  }

  public recordCorrection(input: VerifiedIntentCorrection): LearnLoopRule {
    assertCorrection(input);
    const now = input.recordedAt ?? new Date().toISOString();
    const contextKey = contextFeatures(input.intent, input.uiState).key;
    const sameSource = [...this.rules.values()].filter(
      (rule) =>
        rule.contextKey === contextKey &&
        rule.fromStage === input.predictedStage &&
        rule.status !== "revoked",
    );
    const conflict = sameSource.some(
      (rule) => rule.toStage !== input.correctedStage,
    );
    if (conflict) {
      for (const rule of sameSource) {
        this.rules.set(rule.id, {
          ...rule,
          status: "quarantined",
          updatedAt: now,
        });
      }
    }

    const existing = sameSource.find(
      (rule) => rule.toStage === input.correctedStage,
    );
    const taskIds = new Set(existing?.taskIds ?? []);
    taskIds.add(input.taskId);
    const evidenceCount = taskIds.size;
    const status: LearnLoopRuleStatus = conflict
      ? "quarantined"
      : evidenceCount >= this.minimumEvidence
        ? "active"
        : "candidate";
    const rule: LearnLoopRule = {
      id: existing?.id ?? input.correctionId ?? randomUUID(),
      contextKey,
      fromStage: input.predictedStage,
      toStage: input.correctedStage,
      ...(input.correctedSkillName
        ? { skillName: input.correctedSkillName }
        : skillForStage[input.correctedStage]
          ? { skillName: skillForStage[input.correctedStage] }
          : {}),
      status,
      evidenceCount,
      taskIds: [...taskIds].sort(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rules.set(rule.id, rule);
    this.enforceRuleLimit();
    return cloneRule(rule);
  }

  public revokeRule(ruleId: string, recordedAt = new Date().toISOString()): boolean {
    const existing = this.rules.get(ruleId);
    if (!existing) return false;
    this.rules.set(ruleId, {
      ...existing,
      status: "revoked",
      updatedAt: recordedAt,
    });
    return true;
  }

  public listRules(): LearnLoopRule[] {
    return [...this.rules.values()]
      .map(cloneRule)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public exportSnapshot(): LearnLoopSnapshot {
    return {
      schemaVersion: "lhic-learnloop-v1",
      rules: this.listRules(),
    };
  }

  public importSnapshot(snapshot: LearnLoopSnapshot): void {
    if (snapshot.schemaVersion !== "lhic-learnloop-v1") {
      throw new Error("LearnLoop snapshot schema is unsupported.");
    }
    for (const rule of snapshot.rules) {
      assertRule(rule);
      this.rules.set(rule.id, cloneRule(rule));
    }
    this.enforceRuleLimit();
  }

  private applyRules(
    contextKey: string,
    base: IntentPrediction,
  ): {
    prediction: IntentPrediction;
    appliedRuleIds: string[];
    conflict: boolean;
  } {
    const matching = [...this.rules.values()].filter(
      (rule) =>
        rule.contextKey === contextKey &&
        rule.fromStage === base.predictedIntent &&
        rule.status !== "revoked",
    );
    const active = matching.filter((rule) => rule.status === "active");
    const targets = new Set(active.map((rule) => rule.toStage));
    const conflict =
      matching.some((rule) => rule.status === "quarantined") || targets.size > 1;
    if (conflict || active.length !== 1) {
      return { prediction: base, appliedRuleIds: [], conflict };
    }
    const rule = active[0]!;
    const confidenceBoost = Math.min(0.12, rule.evidenceCount * 0.025);
    return {
      prediction: {
        predictedIntent: rule.toStage,
        ...(rule.skillName ? { skillName: rule.skillName } : {}),
        confidence: Math.min(0.99, Math.max(base.confidence, 0.78) + confidenceBoost),
        evidence: [
          ...base.evidence,
          `LearnLoop applied verifier-backed rule ${rule.id}.`,
        ],
      },
      appliedRuleIds: [rule.id],
      conflict: false,
    };
  }

  private detectDrift(
    sessionId: string,
    intentFingerprint: string,
    prediction: IntentPrediction,
    correctionConflict: boolean,
    intent: UserIntent,
  ): IntentDriftReport {
    const reasons: string[] = [];
    let score = 0;
    const previous = this.sessions.get(sessionId);
    if (correctionConflict) {
      score += 0.55;
      reasons.push("Conflicting learned corrections are quarantined.");
    }
    if (
      previous &&
      previous.intentFingerprint === intentFingerprint &&
      previous.stages.at(-1) !== prediction.predictedIntent
    ) {
      score += 0.35;
      reasons.push("Predicted intent changed while the intent fingerprint stayed stable.");
    }
    if (previous && previous.confidence - prediction.confidence >= 0.2) {
      score += 0.2;
      reasons.push("Prediction confidence dropped sharply across turns.");
    }
    const recentStages = [
      ...(previous?.stages ?? []),
      prediction.predictedIntent,
    ].slice(-4);
    if (oscillationCount(recentStages) >= 2) {
      score += 0.25;
      reasons.push("Intent prediction is oscillating across recent turns.");
    }
    if (intent.missingInformation.length > 0) {
      score += 0.2;
      reasons.push("The user intent still has missing information.");
    }
    if (
      intent.riskLevel === "high" ||
      intent.riskLevel === "unknown" ||
      intent.requiresConfirmation
    ) {
      score += 0.4;
      reasons.push("Risk policy requires human confirmation independently of learning.");
    }
    const boundedScore = Math.min(1, score);
    return {
      detected: boundedScore >= this.driftThreshold,
      score: boundedScore,
      reasons,
    };
  }

  private rememberSession(
    sessionId: string,
    intentFingerprint: string,
    prediction: IntentPrediction,
  ): void {
    if (!sessionId.trim() || sessionId.length > 256) {
      throw new Error("Human-intent decisions require a bounded session ID.");
    }
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      intentFingerprint,
      stages: [...(previous?.stages ?? []), prediction.predictedIntent].slice(-4),
      confidence: prediction.confidence,
      updatedAt: Date.now(),
    });
    if (this.sessions.size > this.maximumSessions) {
      const oldest = [...this.sessions.entries()].sort(
        ([, left], [, right]) => left.updatedAt - right.updatedAt,
      )[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
  }

  private enforceRuleLimit(): void {
    while (this.rules.size > this.maximumRules) {
      const removable = [...this.rules.values()]
        .filter((rule) => rule.status !== "active")
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
      const fallback = [...this.rules.values()].sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt),
      )[0];
      const selected = removable ?? fallback;
      if (!selected) return;
      this.rules.delete(selected.id);
    }
  }
}

function admitPrediction(
  intent: UserIntent,
  prediction: IntentPrediction,
  drift: IntentDriftReport,
  options: { fastPathThreshold: number },
): { admission: HumanIntentAdmission; reason: string } {
  if (
    intent.riskLevel === "high" ||
    intent.riskLevel === "unknown" ||
    intent.requiresConfirmation
  ) {
    return {
      admission: "require_confirmation",
      reason: "Risk policy cannot be lowered by intent learning.",
    };
  }
  if (drift.detected) {
    return {
      admission: "require_confirmation",
      reason: "Intent drift was detected before execution.",
    };
  }
  if (!prediction.skillName || prediction.confidence < options.fastPathThreshold) {
    return {
      admission: "defer_to_slow_path",
      reason: "Prediction is not sufficiently certain for deterministic Fast Path execution.",
    };
  }
  return {
    admission: "execute_fast",
    reason: "Prediction is low-risk, deterministic, and above the Fast Path threshold.",
  };
}

function contextFeatures(
  intent: UserIntent,
  state: NormalizedUIState,
): ContextFeatures {
  const roles = [...new Set(state.objects.map((object) => object.role?.toLowerCase()).filter(isString))].sort();
  const labelHints = [...new Set(state.objects.flatMap((object) => semanticHints(`${object.label ?? ""} ${object.selector ?? ""}`)))].sort();
  const goalHints = semanticHints(intent.goal);
  const constraintShape = shapeOf(intent.constraints);
  const safeFeatures = {
    surface: state.surface,
    riskLevel: intent.riskLevel,
    requiresConfirmation: intent.requiresConfirmation,
    roles,
    labelHints,
    goalHints,
    constraintShape,
    objectCountBucket: Math.min(20, Math.floor(state.objects.length / 5)),
  };
  return {
    key: hashState(safeFeatures),
    intentFingerprint: hashState({
      goalHints,
      constraintShape,
      riskLevel: intent.riskLevel,
      missingCount: intent.missingInformation.length,
    }),
  };
}

function semanticHints(value: string): string[] {
  const normalized = value.toLowerCase();
  return [
    ["login", /login|log in|sign in|username|email|password|passcode/],
    ["form", /form|fill|field|required|submit|save|continue|next/],
    ["search", /search|find|look up|lookup|query/],
    ["download", /download|export|save file/],
    ["test", /test|check|verify/],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(normalized))
    .map(([hint]) => hint as string);
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (depth >= 4) return "depth-limit";
  if (Array.isArray(value)) {
    return value.slice(0, 16).map((item) => shapeOf(item, depth + 1));
  }
  if (!value || typeof value !== "object") return typeof value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 32)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, shapeOf(child, depth + 1)]),
  );
}

function oscillationCount(stages: readonly ControllerStage[]): number {
  let changes = 0;
  for (let index = 1; index < stages.length; index += 1) {
    if (stages[index] !== stages[index - 1]) changes += 1;
  }
  return changes;
}

function assertCorrection(input: VerifiedIntentCorrection): void {
  if (!input.taskId.trim() || input.taskId.length > 256) {
    throw new Error("LearnLoop corrections require a bounded task ID.");
  }
  if (!input.confirmedByUser) {
    throw new Error("LearnLoop refuses corrections that were not confirmed by the user.");
  }
  if (!input.verification.success || input.verification.evidence.length === 0) {
    throw new Error("LearnLoop requires successful verifier evidence before learning.");
  }
  if (input.predictedStage === input.correctedStage) {
    throw new Error("LearnLoop corrections must change the predicted intent.");
  }
  if (
    input.correctedSkillName !== undefined &&
    (!input.correctedSkillName.trim() || input.correctedSkillName.length > 128)
  ) {
    throw new Error("Corrected skill names must be bounded non-empty strings.");
  }
}

function assertRule(rule: LearnLoopRule): void {
  if (
    !rule.id.trim() ||
    !/^[a-f0-9]{64}$/.test(rule.contextKey) ||
    !Number.isSafeInteger(rule.evidenceCount) ||
    rule.evidenceCount < 1 ||
    rule.taskIds.length !== new Set(rule.taskIds).size ||
    !["candidate", "active", "quarantined", "revoked"].includes(rule.status)
  ) {
    throw new Error("LearnLoop snapshot contains an invalid rule.");
  }
}

function cloneRule(rule: LearnLoopRule): LearnLoopRule {
  return { ...rule, taskIds: [...rule.taskIds] };
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function boundedProbability(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be greater than zero and at most one.`);
  }
  return value;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}
