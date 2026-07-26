import {
  randomBytes,
  randomUUID,
  sign,
  verify,
  type KeyLike,
} from "node:crypto";

import type {
  NormalizedUIState,
  UserIntent,
  VerificationResult,
} from "@lhic/schema";
import { hashState } from "@lhic/trace";

import type { HumanIntentLearnLoop } from "./human-intent-learnloop.js";
import {
  type CorrectionEvidenceSplit,
  type LearnLoopRule,
} from "./human-intent-learnloop.js";
import type { ControllerStage } from "./stage-classifier.js";

const maximumApprovalLifetimeMs = 5 * 60 * 1_000;
const maximumApprovalClockSkewMs = 30_000;
const correctionApprovalSchema = "lhic-correction-approval-v1" as const;
const approvalClaimKeys = [
  "approvalId",
  "approvedBySha256",
  "correctedStage",
  "expiresAt",
  "intentSha256",
  "issuedAt",
  "nonce",
  "predictedStage",
  "schemaVersion",
  "split",
  "taskIdSha256",
  "traceSha256",
  "uiFingerprint",
  "verificationSha256",
  "verifierVersion",
].sort();
const controllerStages = new Set<ControllerStage>([
  "login",
  "form_filling",
  "search",
  "download",
  "test_web_flow",
  "unknown",
]);
const deterministicCorrectionTargets = new Set<ControllerStage>([
  "login",
  "form_filling",
  "search",
  "download",
  "test_web_flow",
]);

export interface HumanIntentCorrectionBinding {
  taskId: string;
  traceSha256: string;
  verifierVersion: string;
  split: CorrectionEvidenceSplit;
  intent: UserIntent;
  uiState: NormalizedUIState;
  predictedStage: ControllerStage;
  correctedStage: ControllerStage;
  verification: VerificationResult;
}

export interface HumanIntentCorrectionApprovalClaim {
  schemaVersion: typeof correctionApprovalSchema;
  approvalId: string;
  nonce: string;
  approvedBySha256: string;
  taskIdSha256: string;
  intentSha256: string;
  uiFingerprint: string;
  traceSha256: string;
  verificationSha256: string;
  verifierVersion: string;
  predictedStage: ControllerStage;
  correctedStage: ControllerStage;
  split: CorrectionEvidenceSplit;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedHumanIntentCorrectionApproval {
  claim: HumanIntentCorrectionApprovalClaim;
  signature: string;
}

export interface CreateCorrectionApprovalOptions {
  now?: Date;
  expiresInMs?: number;
  approvalId?: string;
  nonce?: string;
}

export interface TrustedCorrectionIngestionOptions {
  publicKey: KeyLike;
  now?: () => Date;
  maximumConsumedApprovals?: number;
  isApprovalRevoked?: (approvalId: string) => boolean;
}

interface ValidatedApproval {
  claim: HumanIntentCorrectionApprovalClaim;
  expiresAtMs: number;
}

/**
 * Creates a privacy-minimized claim. Raw task IDs, goals, UI labels, selectors,
 * values, verifier evidence, and approver identifiers are never embedded in it.
 */
export function createHumanIntentCorrectionApprovalClaim(
  binding: HumanIntentCorrectionBinding,
  approvedBy: string,
  options: CreateCorrectionApprovalOptions = {},
): HumanIntentCorrectionApprovalClaim {
  assertBindingInputs(binding);
  if (!approvedBy.trim() || approvedBy.length > 512) {
    throw new Error(
      "Human Intent correction approvals require a bounded approver identifier.",
    );
  }
  const now = options.now ?? new Date();
  const issuedAt = canonicalTimestamp(now.toISOString());
  const expiresInMs = options.expiresInMs ?? maximumApprovalLifetimeMs;
  if (
    !Number.isSafeInteger(expiresInMs) ||
    expiresInMs < 1 ||
    expiresInMs > maximumApprovalLifetimeMs
  ) {
    throw new Error(
      "Human Intent correction approvals may last from 1ms through five minutes.",
    );
  }
  const claim: HumanIntentCorrectionApprovalClaim = {
    schemaVersion: correctionApprovalSchema,
    approvalId: options.approvalId ?? randomUUID(),
    nonce: options.nonce ?? randomBytes(32).toString("hex"),
    approvedBySha256: hashState(approvedBy.trim()),
    taskIdSha256: hashState(binding.taskId),
    intentSha256: hashState(binding.intent),
    uiFingerprint: humanIntentCorrectionUiFingerprint(binding.uiState),
    traceSha256: binding.traceSha256,
    verificationSha256: hashState(binding.verification),
    verifierVersion: binding.verifierVersion,
    predictedStage: binding.predictedStage,
    correctedStage: binding.correctedStage,
    split: binding.split,
    issuedAt,
    expiresAt: new Date(now.getTime() + expiresInMs).toISOString(),
  };
  assertClaimShape(claim);
  return claim;
}

export function signHumanIntentCorrectionApproval(
  claim: HumanIntentCorrectionApprovalClaim,
  privateKey: KeyLike,
): SignedHumanIntentCorrectionApproval {
  assertClaimShape(claim);
  return {
    claim: { ...claim },
    signature: sign(
      null,
      Buffer.from(correctionApprovalPayload(claim)),
      privateKey,
    ).toString("base64"),
  };
}

export function createSignedHumanIntentCorrectionApproval(
  binding: HumanIntentCorrectionBinding,
  approvedBy: string,
  privateKey: KeyLike,
  options: CreateCorrectionApprovalOptions = {},
): SignedHumanIntentCorrectionApproval {
  return signHumanIntentCorrectionApproval(
    createHumanIntentCorrectionApprovalClaim(binding, approvedBy, options),
    privateKey,
  );
}

/**
 * Verifies and consumes one correction approval before mutating LearnLoop.
 * Consumption is fail-closed: after a valid bound approval reaches the mutation
 * boundary, it cannot be retried even when LearnLoop later rejects the update.
 */
export class TrustedHumanIntentCorrectionIngestion {
  private readonly now: () => Date;
  private readonly maximumConsumedApprovals: number;
  private readonly isApprovalRevoked: (approvalId: string) => boolean;
  private readonly consumedApprovalIds = new Map<string, number>();
  private readonly consumedNonces = new Map<string, number>();

  public constructor(
    private readonly options: TrustedCorrectionIngestionOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.maximumConsumedApprovals = boundedInteger(
      options.maximumConsumedApprovals ?? 4_096,
      1,
      100_000,
      "maximumConsumedApprovals",
    );
    this.isApprovalRevoked = options.isApprovalRevoked ?? (() => false);
  }

  public ingest(
    learnLoop: HumanIntentLearnLoop,
    binding: HumanIntentCorrectionBinding,
    approval: SignedHumanIntentCorrectionApproval,
  ): LearnLoopRule {
    assertBindingInputs(binding);
    const now = this.now();
    const validated = validateSignedApproval(
      approval,
      this.options.publicKey,
      now,
    );
    this.pruneExpired(now.getTime());

    let revoked = true;
    try {
      revoked = this.isApprovalRevoked(validated.claim.approvalId);
    } catch {
      throw new Error(
        "Human Intent correction approval revocation status could not be verified.",
      );
    }
    if (revoked) {
      throw new Error("Human Intent correction approval has been revoked.");
    }
    if (this.consumedApprovalIds.has(validated.claim.approvalId)) {
      throw new Error("Human Intent correction approval replay was rejected.");
    }
    if (this.consumedNonces.has(validated.claim.nonce)) {
      throw new Error(
        "Human Intent correction approval nonce replay was rejected.",
      );
    }

    assertClaimMatchesBinding(validated.claim, binding);
    if (this.consumedApprovalIds.size >= this.maximumConsumedApprovals) {
      throw new Error(
        "Human Intent correction replay cache is full of unexpired approvals.",
      );
    }

    this.consumedApprovalIds.set(
      validated.claim.approvalId,
      validated.expiresAtMs,
    );
    this.consumedNonces.set(validated.claim.nonce, validated.expiresAtMs);

    return learnLoop.recordCorrection({
      provenance: {
        taskId: binding.taskId,
        uiFingerprint: validated.claim.uiFingerprint,
        traceSha256: binding.traceSha256,
        verifierVersion: binding.verifierVersion,
        split: binding.split,
      },
      intent: binding.intent,
      uiState: binding.uiState,
      predictedStage: binding.predictedStage,
      correctedStage: binding.correctedStage,
      confirmedByUser: true,
      verification: binding.verification,
      recordedAt: now.toISOString(),
    });
  }

  public consumedApprovalCount(): number {
    this.pruneExpired(this.now().getTime());
    return this.consumedApprovalIds.size;
  }

  private pruneExpired(nowMs: number): void {
    for (const [approvalId, expiresAt] of this.consumedApprovalIds) {
      if (expiresAt <= nowMs) this.consumedApprovalIds.delete(approvalId);
    }
    for (const [nonce, expiresAt] of this.consumedNonces) {
      if (expiresAt <= nowMs) this.consumedNonces.delete(nonce);
    }
  }
}

export function humanIntentCorrectionUiFingerprint(
  state: NormalizedUIState,
): string {
  const scope = correctionUiScope(state);
  const objects = state.objects.slice(0, 256).map((object) => ({
    idSha256: object.id ? hashState(object.id.slice(0, 512)) : undefined,
    role: safeBoundedText(object.role, 64),
    labelSha256: object.label
      ? hashState(object.label.slice(0, 1_024))
      : undefined,
    selectorSha256: object.selector
      ? hashState(object.selector.slice(0, 1_024))
      : undefined,
    enabled: object.enabled,
    focused: object.focused,
    source: safeBoundedText(object.source, 64),
  }));
  return hashState({
    surface: state.surface,
    scope,
    objects,
    signalsSha256: hashState(state.signals),
  });
}

function validateSignedApproval(
  approval: SignedHumanIntentCorrectionApproval,
  publicKey: KeyLike,
  now: Date,
): ValidatedApproval {
  assertClaimShape(approval.claim);
  if (
    typeof approval.signature !== "string" ||
    approval.signature.length < 32 ||
    approval.signature.length > 1_024
  ) {
    throw new Error("Human Intent correction approval signature is invalid.");
  }
  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      Buffer.from(correctionApprovalPayload(approval.claim)),
      publicKey,
      Buffer.from(approval.signature, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    throw new Error(
      "Human Intent correction approval signature verification failed.",
    );
  }

  const issuedAtMs = Date.parse(approval.claim.issuedAt);
  const expiresAtMs = Date.parse(approval.claim.expiresAt);
  if (issuedAtMs > now.getTime() + maximumApprovalClockSkewMs) {
    throw new Error("Human Intent correction approval is not valid yet.");
  }
  if (expiresAtMs <= issuedAtMs) {
    throw new Error(
      "Human Intent correction approval expiry must follow its issue time.",
    );
  }
  if (expiresAtMs - issuedAtMs > maximumApprovalLifetimeMs) {
    throw new Error(
      "Human Intent correction approval lifetime exceeds five minutes.",
    );
  }
  if (expiresAtMs <= now.getTime()) {
    throw new Error("Human Intent correction approval has expired.");
  }
  return { claim: approval.claim, expiresAtMs };
}

function assertClaimMatchesBinding(
  claim: HumanIntentCorrectionApprovalClaim,
  binding: HumanIntentCorrectionBinding,
): void {
  const expected = {
    taskIdSha256: hashState(binding.taskId),
    intentSha256: hashState(binding.intent),
    uiFingerprint: humanIntentCorrectionUiFingerprint(binding.uiState),
    traceSha256: binding.traceSha256,
    verificationSha256: hashState(binding.verification),
    verifierVersion: binding.verifierVersion,
    predictedStage: binding.predictedStage,
    correctedStage: binding.correctedStage,
    split: binding.split,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (claim[key as keyof HumanIntentCorrectionApprovalClaim] !== value) {
      throw new Error(
        `Human Intent correction approval does not match the ${key} binding.`,
      );
    }
  }
}

function assertBindingInputs(binding: HumanIntentCorrectionBinding): void {
  if (!binding.taskId.trim() || binding.taskId.length > 256) {
    throw new Error("Human Intent corrections require a bounded task ID.");
  }
  if (!/^[a-f0-9]{64}$/.test(binding.traceSha256)) {
    throw new Error(
      "Human Intent corrections require a SHA-256 trace binding.",
    );
  }
  if (
    !binding.verifierVersion.trim() ||
    binding.verifierVersion.length > 128 ||
    hasControlCharacter(binding.verifierVersion)
  ) {
    throw new Error("Human Intent corrections require a verifier version.");
  }
  if (binding.split !== "training" && binding.split !== "validation") {
    throw new Error("Human Intent correction evidence split is invalid.");
  }
  if (
    !controllerStages.has(binding.predictedStage) ||
    !deterministicCorrectionTargets.has(binding.correctedStage) ||
    binding.predictedStage === binding.correctedStage
  ) {
    throw new Error("Human Intent correction stage binding is invalid.");
  }
  if (
    !binding.verification.success ||
    binding.verification.evidence.length === 0
  ) {
    throw new Error(
      "Human Intent correction ingestion requires successful post-execution verifier evidence.",
    );
  }
}

function assertClaimShape(claim: HumanIntentCorrectionApprovalClaim): void {
  const keys = Object.keys(claim).sort();
  if (
    keys.length !== approvalClaimKeys.length ||
    !keys.every((key, index) => key === approvalClaimKeys[index]) ||
    claim.schemaVersion !== correctionApprovalSchema ||
    !isUuid(claim.approvalId) ||
    !/^[a-f0-9]{64}$/.test(claim.nonce) ||
    !/^[a-f0-9]{64}$/.test(claim.approvedBySha256) ||
    !/^[a-f0-9]{64}$/.test(claim.taskIdSha256) ||
    !/^[a-f0-9]{64}$/.test(claim.intentSha256) ||
    !/^[a-f0-9]{64}$/.test(claim.uiFingerprint) ||
    !/^[a-f0-9]{64}$/.test(claim.traceSha256) ||
    !/^[a-f0-9]{64}$/.test(claim.verificationSha256) ||
    !controllerStages.has(claim.predictedStage) ||
    !deterministicCorrectionTargets.has(claim.correctedStage) ||
    claim.predictedStage === claim.correctedStage ||
    (claim.split !== "training" && claim.split !== "validation") ||
    !claim.verifierVersion.trim() ||
    claim.verifierVersion.length > 128 ||
    hasControlCharacter(claim.verifierVersion)
  ) {
    throw new Error("Human Intent correction approval claim is invalid.");
  }
  canonicalTimestamp(claim.issuedAt);
  canonicalTimestamp(claim.expiresAt);
}

function correctionApprovalPayload(
  claim: HumanIntentCorrectionApprovalClaim,
): string {
  return JSON.stringify({
    schemaVersion: claim.schemaVersion,
    approvalId: claim.approvalId,
    nonce: claim.nonce,
    approvedBySha256: claim.approvedBySha256,
    taskIdSha256: claim.taskIdSha256,
    intentSha256: claim.intentSha256,
    uiFingerprint: claim.uiFingerprint,
    traceSha256: claim.traceSha256,
    verificationSha256: claim.verificationSha256,
    verifierVersion: claim.verifierVersion,
    predictedStage: claim.predictedStage,
    correctedStage: claim.correctedStage,
    split: claim.split,
    issuedAt: claim.issuedAt,
    expiresAt: claim.expiresAt,
  });
}

function correctionUiScope(state: NormalizedUIState): string {
  if (state.surface === "browser" && state.url) {
    try {
      return `browser:${new URL(state.url).origin}`;
    } catch {
      return "browser:invalid-origin";
    }
  }
  if (state.app) return `${state.surface}:app:${state.app.slice(0, 256)}`;
  if (state.screenType) {
    return `${state.surface}:screen:${state.screenType.slice(0, 256)}`;
  }
  return `${state.surface}:unknown`;
}

function safeBoundedText(
  value: string | undefined,
  maximumLength: number,
): string | undefined {
  if (!value) return undefined;
  const bounded = value.slice(0, maximumLength);
  return hasControlCharacter(bounded) ? "other" : bounded;
}

function canonicalTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(
      "Human Intent correction approval timestamps must be valid dates.",
    );
  }
  const canonical = new Date(timestamp).toISOString();
  if (canonical !== value) {
    throw new Error(
      "Human Intent correction approval timestamps must be canonical ISO strings.",
    );
  }
  return canonical;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }
  return false;
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
