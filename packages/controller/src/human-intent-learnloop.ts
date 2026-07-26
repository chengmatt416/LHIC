import {
  createHmac,
  randomUUID,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";

import type {
  NormalizedUIState,
  UserIntent,
  VerificationResult,
} from "@lhic/schema";
import { hashState } from "@lhic/trace";

import { predictIntent, type IntentPrediction } from "./predictor.js";
import { classifyStage, type ControllerStage } from "./stage-classifier.js";

export type HumanIntentAdmission =
  "execute_fast" | "require_confirmation" | "defer_to_slow_path";

export type LearnLoopRuleStatus =
  "candidate" | "active" | "quarantined" | "revoked";

export type CorrectionEvidenceSplit = "training" | "validation";

export interface CorrectionProvenance {
  taskId: string;
  uiFingerprint: string;
  traceSha256: string;
  verifierVersion: string;
  split: CorrectionEvidenceSplit;
}

export interface LearnLoopRule {
  id: string;
  contextKey: string;
  scopeSha256: string;
  featureTokens: string[];
  fromStage: ControllerStage;
  toStage: ControllerStage;
  skillName?: string;
  status: LearnLoopRuleStatus;
  trainingTaskHashes: string[];
  trainingUiFingerprints: string[];
  validationUiFingerprints: string[];
  successfulOutcomeHashes: string[];
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LearnLoopSnapshot {
  schemaVersion: "lhic-learnloop-v3";
  rules: LearnLoopRule[];
}

export interface SignedLearnLoopSnapshot {
  snapshot: LearnLoopSnapshot;
  hmacSha256: string;
}

export interface VerifiedIntentCorrection {
  provenance: CorrectionProvenance;
  intent: UserIntent;
  uiState: NormalizedUIState;
  predictedStage: ControllerStage;
  correctedStage: ControllerStage;
  confirmedByUser: boolean;
  verification: VerificationResult;
  recordedAt?: string;
}

export interface AppliedPredictionOutcome {
  ruleId: string;
  taskId: string;
  success: boolean;
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
  classificationCandidates: ControllerStage[];
  drift: IntentDriftReport;
  appliedRuleIds: string[];
  decisionLatencyMs: number;
}

export interface HumanIntentLearnLoopOptions {
  minimumTrainingEvidence?: number;
  minimumValidationEvidence?: number;
  maximumRules?: number;
  fastPathThreshold?: number;
  driftThreshold?: number;
  similarityThreshold?: number;
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
  scopeSha256: string;
  tokens: string[];
  intentFingerprint: string;
}

interface AppliedRules {
  prediction: IntentPrediction;
  appliedRuleIds: string[];
  conflict: boolean;
  ineligibleRule: boolean;
}

const controllerStages = new Set<ControllerStage>([
  "login",
  "form_filling",
  "search",
  "download",
  "test_web_flow",
  "unknown",
]);

const skillForStage: Partial<Record<ControllerStage, string>> = {
  login: "login",
  form_filling: "fill_form",
  search: "search",
  download: "download_file",
  test_web_flow: "test_web_flow",
};

/**
 * Runs LHIC's existing human-intent predictor first. LearnLoop may then re-rank
 * only to a currently observed, known deterministic stage after independent
 * training and validation evidence. It never creates actions or relaxes risk.
 */
export class HumanIntentLearnLoop {
  private readonly rules = new Map<string, LearnLoopRule>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly minimumTrainingEvidence: number;
  private readonly minimumValidationEvidence: number;
  private readonly maximumRules: number;
  private readonly fastPathThreshold: number;
  private readonly driftThreshold: number;
  private readonly similarityThreshold: number;
  private readonly maximumSessions: number;

  public constructor(options: HumanIntentLearnLoopOptions = {}) {
    this.minimumTrainingEvidence = boundedInteger(
      options.minimumTrainingEvidence ?? 3,
      2,
      20,
      "minimumTrainingEvidence",
    );
    this.minimumValidationEvidence = boundedInteger(
      options.minimumValidationEvidence ?? 1,
      1,
      10,
      "minimumValidationEvidence",
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
    this.similarityThreshold = boundedProbability(
      options.similarityThreshold ?? 0.68,
      "similarityThreshold",
    );
  }

  public decide(
    sessionId: string,
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): HumanIntentDecision {
    assertSessionId(sessionId);
    const startedAt = performance.now();
    const classification = classifyStage(intent, uiState);
    const basePrediction = predictIntent(intent, uiState);
    const features = contextFeatures(intent, uiState);
    const learned = this.applyRules(
      features,
      basePrediction,
      classification.candidates,
    );
    const drift = this.detectDrift(
      sessionId,
      features.intentFingerprint,
      learned.prediction,
      learned.conflict,
      learned.ineligibleRule,
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
      classificationCandidates: [...classification.candidates],
      drift,
      appliedRuleIds: learned.appliedRuleIds,
      decisionLatencyMs: performance.now() - startedAt,
    };
  }

  public recordCorrection(input: VerifiedIntentCorrection): LearnLoopRule {
    assertCorrection(input);
    const observedPrediction = predictIntent(input.intent, input.uiState);
    if (observedPrediction.predictedIntent !== input.predictedStage) {
      throw new Error(
        "LearnLoop correction provenance does not match the current base prediction.",
      );
    }
    const now = normalizedTimestamp(input.recordedAt);
    const features = contextFeatures(input.intent, input.uiState);
    const taskHash = hashState(input.provenance.taskId);
    const related = [...this.rules.values()].filter(
      (rule) =>
        rule.fromStage === input.predictedStage &&
        rule.scopeSha256 === features.scopeSha256 &&
        rule.status !== "revoked" &&
        similarity(rule.featureTokens, features.tokens) >=
          this.similarityThreshold,
    );
    const conflictingTargets = related.filter(
      (rule) => rule.toStage !== input.correctedStage,
    );
    const existing = related
      .filter((rule) => rule.toStage === input.correctedStage)
      .sort(
        (left, right) =>
          similarity(right.featureTokens, features.tokens) -
          similarity(left.featureTokens, features.tokens),
      )[0];
    if (input.provenance.split === "validation" && !existing) {
      throw new Error(
        "Validation evidence cannot create a LearnLoop rule; train the candidate first.",
      );
    }
    if (!existing && this.rules.size >= this.maximumRules) {
      this.removeNonActiveRulesUntilSpace();
      if (this.rules.size >= this.maximumRules) {
        throw new Error(
          "LearnLoop rule capacity is full of active rules; explicit revocation is required.",
        );
      }
    }

    const trainingTaskHashes = new Set(existing?.trainingTaskHashes ?? []);
    const trainingUiFingerprints = new Set(
      existing?.trainingUiFingerprints ?? [],
    );
    const validationUiFingerprints = new Set(
      existing?.validationUiFingerprints ?? [],
    );
    if (input.provenance.split === "training") {
      trainingTaskHashes.add(taskHash);
      trainingUiFingerprints.add(input.provenance.uiFingerprint);
    } else {
      if (trainingUiFingerprints.has(input.provenance.uiFingerprint)) {
        throw new Error(
          "Validation UI evidence must be independent from training evidence.",
        );
      }
      validationUiFingerprints.add(input.provenance.uiFingerprint);
    }

    if (conflictingTargets.length > 0) {
      for (const rule of related) {
        this.rules.set(rule.id, {
          ...rule,
          status: "quarantined",
          updatedAt: now,
        });
      }
    }

    const conflict = conflictingTargets.length > 0;
    const status: LearnLoopRuleStatus = conflict
      ? "quarantined"
      : trainingTaskHashes.size >= this.minimumTrainingEvidence &&
          validationUiFingerprints.size >= this.minimumValidationEvidence
        ? "active"
        : "candidate";
    const featureTokens = existing
      ? stableFeatureIntersection(existing.featureTokens, features.tokens)
      : features.tokens;
    const rule: LearnLoopRule = {
      id: existing?.id ?? randomUUID(),
      contextKey: hashState([features.scopeSha256, ...featureTokens]),
      scopeSha256: features.scopeSha256,
      featureTokens,
      fromStage: input.predictedStage,
      toStage: input.correctedStage,
      ...(skillForStage[input.correctedStage]
        ? { skillName: skillForStage[input.correctedStage] }
        : {}),
      status,
      trainingTaskHashes: [...trainingTaskHashes].sort(),
      trainingUiFingerprints: [...trainingUiFingerprints].sort(),
      validationUiFingerprints: [...validationUiFingerprints].sort(),
      successfulOutcomeHashes: [...(existing?.successfulOutcomeHashes ?? [])],
      failureCount: existing?.failureCount ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rules.set(rule.id, rule);
    return cloneRule(rule);
  }

  public recordAppliedOutcome(input: AppliedPredictionOutcome): LearnLoopRule {
    const existing = this.rules.get(input.ruleId);
    if (!existing || existing.status === "revoked") {
      throw new Error("LearnLoop outcome references an unavailable rule.");
    }
    assertOutcome(input);
    const now = normalizedTimestamp(input.recordedAt);
    const outcomeHash = hashState(input.taskId);
    const successfulOutcomeHashes = new Set(existing.successfulOutcomeHashes);
    if (input.success) successfulOutcomeHashes.add(outcomeHash);
    const failureCount = existing.failureCount + (input.success ? 0 : 1);
    const updated: LearnLoopRule = {
      ...existing,
      successfulOutcomeHashes: [...successfulOutcomeHashes].sort(),
      failureCount,
      status: input.success ? existing.status : "quarantined",
      updatedAt: now,
    };
    this.rules.set(updated.id, updated);
    return cloneRule(updated);
  }

  public revokeRule(
    ruleId: string,
    recordedAt = new Date().toISOString(),
  ): boolean {
    const existing = this.rules.get(ruleId);
    if (!existing) return false;
    this.rules.set(ruleId, {
      ...existing,
      status: "revoked",
      updatedAt: normalizedTimestamp(recordedAt),
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
      schemaVersion: "lhic-learnloop-v3",
      rules: this.listRules(),
    };
  }

  public exportSignedSnapshot(
    integrityKey: BinaryLike,
  ): SignedLearnLoopSnapshot {
    assertIntegrityKey(integrityKey);
    const snapshot = this.exportSnapshot();
    return {
      snapshot,
      hmacSha256: snapshotHmac(snapshot, integrityKey),
    };
  }

  public importSignedSnapshot(
    envelope: SignedLearnLoopSnapshot,
    integrityKey: BinaryLike,
  ): void {
    assertIntegrityKey(integrityKey);
    if (!/^[a-f0-9]{64}$/.test(envelope.hmacSha256)) {
      throw new Error("LearnLoop snapshot HMAC is invalid.");
    }
    const expected = Buffer.from(
      snapshotHmac(envelope.snapshot, integrityKey),
      "hex",
    );
    const actual = Buffer.from(envelope.hmacSha256, "hex");
    if (!timingSafeEqual(expected, actual)) {
      throw new Error("LearnLoop snapshot integrity verification failed.");
    }
    assertSnapshot(
      envelope.snapshot,
      this.maximumRules,
      this.minimumTrainingEvidence,
      this.minimumValidationEvidence,
    );
    const staged = new Map<string, LearnLoopRule>();
    for (const rule of envelope.snapshot.rules) {
      staged.set(rule.id, cloneRule(rule));
    }
    assertNoActiveConflicts([...staged.values()], this.similarityThreshold);
    this.rules.clear();
    for (const [id, rule] of staged) this.rules.set(id, rule);
  }

  private applyRules(
    features: ContextFeatures,
    base: IntentPrediction,
    classificationCandidates: readonly ControllerStage[],
  ): AppliedRules {
    const related = [...this.rules.values()]
      .map((rule) => ({
        rule,
        similarity: similarity(rule.featureTokens, features.tokens),
      }))
      .filter(
        ({ rule, similarity: score }) =>
          rule.fromStage === base.predictedIntent &&
          rule.scopeSha256 === features.scopeSha256 &&
          rule.status !== "revoked" &&
          score >= this.similarityThreshold,
      )
      .sort((left, right) => right.similarity - left.similarity);
    const conflict = related.some(({ rule }) => rule.status === "quarantined");
    const active = related.filter(({ rule }) => rule.status === "active");
    const top = active[0];
    const closeAlternative = active.find(
      (entry, index) =>
        index > 0 &&
        entry.rule.toStage !== top?.rule.toStage &&
        top !== undefined &&
        top.similarity - entry.similarity <= 0.05,
    );
    if (conflict || closeAlternative || !top) {
      return {
        prediction: base,
        appliedRuleIds: [],
        conflict: conflict || Boolean(closeAlternative),
        ineligibleRule: false,
      };
    }
    const eligible =
      classificationCandidates.includes(top.rule.toStage) &&
      Boolean(skillForStage[top.rule.toStage]);
    if (!eligible) {
      return {
        prediction: base,
        appliedRuleIds: [],
        conflict: false,
        ineligibleRule: true,
      };
    }
    const evidenceConfidence = Math.min(
      0.95,
      0.8 +
        top.rule.trainingTaskHashes.length * 0.015 +
        top.rule.validationUiFingerprints.length * 0.025,
    );
    return {
      prediction: {
        predictedIntent: top.rule.toStage,
        skillName: skillForStage[top.rule.toStage]!,
        confidence: Math.max(base.confidence, evidenceConfidence),
        evidence: [
          ...base.evidence,
          `LearnLoop applied validated rule ${top.rule.id}.`,
        ],
      },
      appliedRuleIds: [top.rule.id],
      conflict: false,
      ineligibleRule: false,
    };
  }

  private detectDrift(
    sessionId: string,
    intentFingerprint: string,
    prediction: IntentPrediction,
    correctionConflict: boolean,
    ineligibleRule: boolean,
    intent: UserIntent,
  ): IntentDriftReport {
    const reasons: string[] = [];
    let score = 0;
    const previous = this.sessions.get(sessionId);
    if (correctionConflict) {
      score += 0.6;
      reasons.push("Conflicting learned corrections are quarantined.");
    }
    if (ineligibleRule) {
      score += 0.35;
      reasons.push(
        "A learned target is not supported by the current observed UI candidates.",
      );
    }
    if (
      previous &&
      previous.intentFingerprint === intentFingerprint &&
      previous.stages.at(-1) !== prediction.predictedIntent
    ) {
      score += 0.6;
      reasons.push(
        "Predicted intent changed while the human-intent fingerprint stayed stable.",
      );
    }
    if (previous && previous.confidence - prediction.confidence >= 0.2) {
      score += 0.25;
      reasons.push("Prediction confidence dropped sharply across turns.");
    }
    const recentStages = [
      ...(previous?.stages ?? []),
      prediction.predictedIntent,
    ].slice(-4);
    if (oscillationCount(recentStages) >= 2) {
      score += 0.35;
      reasons.push("Intent prediction is oscillating across recent turns.");
    }
    if (intent.missingInformation.length > 0) {
      score += 0.2;
      reasons.push("The human intent still has missing information.");
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
    const previous = this.sessions.get(sessionId);
    this.sessions.set(sessionId, {
      intentFingerprint,
      stages: [...(previous?.stages ?? []), prediction.predictedIntent].slice(
        -4,
      ),
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

  private removeNonActiveRulesUntilSpace(): void {
    const removable = [...this.rules.values()]
      .filter((rule) => rule.status !== "active")
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    while (this.rules.size >= this.maximumRules && removable.length > 0) {
      const selected = removable.shift();
      if (selected) this.rules.delete(selected.id);
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
  if (
    !prediction.skillName ||
    prediction.confidence < options.fastPathThreshold
  ) {
    return {
      admission: "defer_to_slow_path",
      reason:
        "Prediction is not sufficiently certain for deterministic Fast Path execution.",
    };
  }
  return {
    admission: "execute_fast",
    reason:
      "Prediction is low-risk, deterministic, and above the Fast Path threshold.",
  };
}

function contextFeatures(
  intent: UserIntent,
  state: NormalizedUIState,
): ContextFeatures {
  const objects = state.objects.slice(0, 256);
  const roles = [
    ...new Set(objects.map((object) => safeRole(object.role)).filter(isString)),
  ].sort();
  const labelHints = [
    ...new Set(
      objects.flatMap((object) =>
        semanticHints(`${object.label ?? ""} ${object.selector ?? ""}`),
      ),
    ),
  ].sort();
  const goalHints = semanticHints(intent.goal.slice(0, 4096));
  const constraintTypes = constraintTypeHistogram(intent.constraints);
  const scopeSha256 = contextScopeSha256(state);
  const tokens = [
    `surface:${state.surface}`,
    `risk:${intent.riskLevel}`,
    `confirm:${String(intent.requiresConfirmation)}`,
    `objects:${Math.min(20, Math.floor(objects.length / 5))}`,
    ...roles.map((role) => `role:${role}`),
    ...labelHints.map((hint) => `ui:${hint}`),
    ...goalHints.map((hint) => `goal:${hint}`),
    ...constraintTypes,
  ].sort();
  return {
    key: hashState([scopeSha256, ...tokens]),
    scopeSha256,
    tokens,
    intentFingerprint: hashState([
      ...goalHints.map((hint) => `goal:${hint}`),
      ...constraintTypes,
      `risk:${intent.riskLevel}`,
      `confirm:${String(intent.requiresConfirmation)}`,
      `missing:${Math.min(10, intent.missingInformation.length)}`,
      `goal-length:${Math.min(20, Math.floor(intent.goal.length / 32))}`,
    ]),
  };
}

function contextScopeSha256(state: NormalizedUIState): string {
  let scope = `surface:${state.surface}:unknown`;
  if (state.surface === "browser" && state.url) {
    try {
      scope = `browser:${new URL(state.url).origin}`;
    } catch {
      scope = "browser:invalid-origin";
    }
  } else if (state.app) {
    scope = `${state.surface}:app:${state.app.slice(0, 256)}`;
  } else if (state.screenType) {
    scope = `${state.surface}:screen:${state.screenType.slice(0, 256)}`;
  }
  return hashState(scope);
}

function semanticHints(value: string): string[] {
  const normalized = value.toLowerCase();
  return [
    [
      "login",
      /login|log in|sign in|username|email|password|passcode|登入|登錄|帳號|密碼/,
    ],
    [
      "form",
      /form|fill|field|required|submit|save|continue|next|表單|填寫|欄位|必填|送出|儲存|繼續|下一步/,
    ],
    ["search", /search|find|look up|lookup|query|搜尋|查找|查詢/],
    ["download", /download|export|save file|下載|匯出/],
    ["test", /test|check|verify|測試|檢查|驗證/],
  ]
    .filter(([, pattern]) => (pattern as RegExp).test(normalized))
    .map(([hint]) => hint as string);
}

function safeRole(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  return /^[a-z0-9_-]{1,32}$/.test(normalized) ? normalized : "other";
}

function constraintTypeHistogram(
  constraints: Record<string, unknown>,
): string[] {
  const counts = new Map<string, number>();
  for (const value of Object.values(constraints).slice(0, 32)) {
    const type = Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `constraint:${type}:${Math.min(16, count)}`);
}

function stableFeatureIntersection(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const incomingSet = new Set(incoming);
  const intersection = existing.filter((token) => incomingSet.has(token));
  return intersection.length >= 3 ? intersection : [...existing];
}

function similarity(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection += 1;
  }
  return intersection / union.size;
}

function oscillationCount(stages: readonly ControllerStage[]): number {
  let changes = 0;
  for (let index = 1; index < stages.length; index += 1) {
    if (stages[index] !== stages[index - 1]) changes += 1;
  }
  return changes;
}

function assertCorrection(input: VerifiedIntentCorrection): void {
  assertProvenance(input.provenance);
  if (!input.confirmedByUser) {
    throw new Error(
      "LearnLoop refuses corrections that were not confirmed by the user.",
    );
  }
  if (!input.verification.success || input.verification.evidence.length === 0) {
    throw new Error(
      "LearnLoop requires successful verifier evidence before learning.",
    );
  }
  if (input.predictedStage === input.correctedStage) {
    throw new Error("LearnLoop corrections must change the predicted intent.");
  }
  if (!skillForStage[input.correctedStage]) {
    throw new Error(
      "LearnLoop corrections may target only known deterministic LHIC stages.",
    );
  }
}

function assertProvenance(provenance: CorrectionProvenance): void {
  if (!provenance.taskId.trim() || provenance.taskId.length > 256) {
    throw new Error("LearnLoop corrections require a bounded task ID.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(provenance.uiFingerprint) ||
    !/^[a-f0-9]{64}$/.test(provenance.traceSha256)
  ) {
    throw new Error(
      "LearnLoop correction provenance requires SHA-256 UI and trace fingerprints.",
    );
  }
  if (
    !provenance.verifierVersion.trim() ||
    provenance.verifierVersion.length > 128
  ) {
    throw new Error(
      "LearnLoop correction provenance requires a verifier version.",
    );
  }
  if (provenance.split !== "training" && provenance.split !== "validation") {
    throw new Error("LearnLoop correction evidence split is invalid.");
  }
}

function assertOutcome(input: AppliedPredictionOutcome): void {
  if (!input.taskId.trim() || input.taskId.length > 256) {
    throw new Error("LearnLoop outcomes require a bounded task ID.");
  }
  if (input.success) {
    if (
      !input.verification.success ||
      input.verification.evidence.length === 0
    ) {
      throw new Error(
        "Successful outcomes require successful verifier evidence.",
      );
    }
  } else if (
    input.verification.success ||
    (input.verification.evidence.length === 0 && !input.verification.error)
  ) {
    throw new Error("Failed outcomes require verifier failure evidence.");
  }
}

function assertSnapshot(
  snapshot: LearnLoopSnapshot,
  maximumRules: number,
  minimumTrainingEvidence: number,
  minimumValidationEvidence: number,
): void {
  if (
    snapshot.schemaVersion !== "lhic-learnloop-v3" ||
    !Array.isArray(snapshot.rules) ||
    snapshot.rules.length > maximumRules
  ) {
    throw new Error("LearnLoop snapshot schema or size is invalid.");
  }
  const ids = new Set<string>();
  for (const rule of snapshot.rules) {
    assertRule(rule, minimumTrainingEvidence, minimumValidationEvidence);
    if (ids.has(rule.id)) {
      throw new Error("LearnLoop snapshot contains duplicate rule IDs.");
    }
    ids.add(rule.id);
  }
}

function assertRule(
  rule: LearnLoopRule,
  minimumTrainingEvidence: number,
  minimumValidationEvidence: number,
): void {
  if (
    !rule.id.trim() ||
    !/^[a-f0-9]{64}$/.test(rule.contextKey) ||
    !/^[a-f0-9]{64}$/.test(rule.scopeSha256) ||
    rule.contextKey !== hashState([rule.scopeSha256, ...rule.featureTokens]) ||
    !controllerStages.has(rule.fromStage) ||
    !controllerStages.has(rule.toStage) ||
    rule.fromStage === rule.toStage ||
    !skillForStage[rule.toStage] ||
    rule.skillName !== skillForStage[rule.toStage] ||
    !["candidate", "active", "quarantined", "revoked"].includes(rule.status) ||
    !Number.isSafeInteger(rule.failureCount) ||
    rule.failureCount < 0 ||
    rule.featureTokens.length > 128 ||
    !allUnique(rule.featureTokens) ||
    rule.featureTokens.some(
      (token) =>
        typeof token !== "string" ||
        token.length === 0 ||
        token.length > 128 ||
        /[\u0000-\u001f\u007f]/.test(token),
    ) ||
    (rule.status === "active" &&
      (rule.trainingTaskHashes.length < minimumTrainingEvidence ||
        rule.validationUiFingerprints.length < minimumValidationEvidence)) ||
    !allHashes(rule.trainingTaskHashes) ||
    !allHashes(rule.trainingUiFingerprints) ||
    !allHashes(rule.validationUiFingerprints) ||
    !allHashes(rule.successfulOutcomeHashes)
  ) {
    throw new Error("LearnLoop snapshot contains an invalid rule.");
  }
  normalizedTimestamp(rule.createdAt);
  normalizedTimestamp(rule.updatedAt);
}

function assertNoActiveConflicts(
  rules: readonly LearnLoopRule[],
  similarityThreshold: number,
): void {
  const active = rules.filter((rule) => rule.status === "active");
  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < active.length;
      rightIndex += 1
    ) {
      const left = active[leftIndex]!;
      const right = active[rightIndex]!;
      if (
        left.fromStage === right.fromStage &&
        left.toStage !== right.toStage &&
        similarity(left.featureTokens, right.featureTokens) >=
          similarityThreshold
      ) {
        throw new Error(
          "LearnLoop snapshot contains conflicting active rules.",
        );
      }
    }
  }
}

function snapshotHmac(
  snapshot: LearnLoopSnapshot,
  integrityKey: BinaryLike,
): string {
  return createHmac("sha256", integrityKey)
    .update(JSON.stringify(snapshot))
    .digest("hex");
}

function assertIntegrityKey(integrityKey: BinaryLike): void {
  const length = Buffer.isBuffer(integrityKey)
    ? integrityKey.length
    : Buffer.byteLength(integrityKey);
  if (length < 32) {
    throw new Error(
      "LearnLoop snapshot integrity keys require at least 32 bytes.",
    );
  }
}

function cloneRule(rule: LearnLoopRule): LearnLoopRule {
  return {
    ...rule,
    featureTokens: [...rule.featureTokens],
    trainingTaskHashes: [...rule.trainingTaskHashes],
    trainingUiFingerprints: [...rule.trainingUiFingerprints],
    validationUiFingerprints: [...rule.validationUiFingerprints],
    successfulOutcomeHashes: [...rule.successfulOutcomeHashes],
  };
}

function allUnique(values: readonly string[]): boolean {
  return values.length <= 128 && values.length === new Set(values).size;
}

function allHashes(values: readonly string[]): boolean {
  return (
    allUnique(values) && values.every((value) => /^[a-f0-9]{64}$/.test(value))
  );
}

function normalizedTimestamp(value = new Date().toISOString()): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("LearnLoop timestamps must be valid ISO-compatible dates.");
  }
  return new Date(timestamp).toISOString();
}

function assertSessionId(sessionId: string): void {
  if (!sessionId.trim() || sessionId.length > 256) {
    throw new Error("Human-intent decisions require a bounded session ID.");
  }
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
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
