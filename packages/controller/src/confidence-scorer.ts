import type { NormalizedUIState, RiskLevel, UserIntent } from "@lhic/schema";

import type {
  ControllerStage,
  StageClassification,
} from "./stage-classifier.js";

export interface ConfidenceScoringOptions {
  /** UI state to evaluate for quality signals (object richness, relevant controls). */
  uiState?: NormalizedUIState;
  /** Historical success rate for this kind of task, 0–1. Omit when unknown. */
  historicalSuccessRate?: number;
}

/**
 * Continuous confidence score in [0, 1].
 *
 * Factors (weights adjust when historical data is available):
 *  1. Stage classification quality — exponential decay with candidate count
 *  2. UI state quality — object richness, stage-relevant controls, surface
 *  3. Risk level — low boosts, unknown/high penalise
 *  4. Historical success rate — blended in when provided
 */
export function scoreConfidence(
  classification: StageClassification,
  intent: UserIntent,
  options: ConfidenceScoringOptions = {},
): number {
  const stage = stageFactor(classification);
  const ui = options.uiState
    ? uiQualityFactor(options.uiState, classification.stage)
    : DEFAULT_UI_FACTOR;
  const risk = riskFactor(intent.riskLevel);

  let raw: number;
  if (options.historicalSuccessRate != null) {
    const hist = clamp(options.historicalSuccessRate, 0, 1);
    // With history: stage 0.30, UI 0.20, risk 0.20, history 0.30
    raw = stage * 0.3 + ui * 0.2 + risk * 0.2 + hist * 0.3;
  } else {
    // Without history: stage 0.45, UI 0.30, risk 0.25
    raw = stage * 0.45 + ui * 0.3 + risk * 0.25;
  }

  return clamp(raw, 0, 1);
}

// ---------------------------------------------------------------------------
// Factor computations
// ---------------------------------------------------------------------------

/**
 * Stage quality: 0 when unknown, otherwise exponential decay with candidate
 * count (1 candidate → 1.0, 2 → 0.64, 3 → 0.41, …).
 */
function stageFactor(classification: StageClassification): number {
  if (classification.stage === "unknown") {
    return 0.1;
  }
  return Math.exp(-0.45 * (classification.candidates.length - 1));
}

/** Neutral default used when no UI state is supplied. */
const DEFAULT_UI_FACTOR = 0.7;

/**
 * UI quality in [0, 1]:
 *  - Object richness (saturates at 8) → up to 0.6
 *  - Stage-relevant controls found → +0.3
 *  - Browser surface → +0.1
 */
function uiQualityFactor(
  state: NormalizedUIState,
  stage: ControllerStage,
): number {
  const richness = Math.min(state.objects.length / 8, 1) * 0.6;
  const relevance = hasRelevantControls(state, stage) ? 0.3 : 0;
  const surface = state.surface === "browser" ? 0.1 : 0;
  return clamp(richness + relevance + surface, 0, 1);
}

function hasRelevantControls(
  state: NormalizedUIState,
  stage: ControllerStage,
): boolean {
  const text = state.objects.map((o) =>
    `${o.role ?? ""} ${o.label ?? ""}`.toLowerCase(),
  );
  switch (stage) {
    case "search":
      return text.some((t) => /search|find|query/.test(t));
    case "login":
      return text.some((t) => /password|passcode|email|username/.test(t));
    case "form_filling":
      return text.some((t) => /required|\*|submit|save/.test(t));
    case "download":
      return text.some((t) => /download|export/.test(t));
    case "test_web_flow":
      return state.objects.length > 0;
    case "unknown":
      return false;
  }
}

/** Maps risk level to a [0, 1] quality factor. */
function riskFactor(riskLevel: RiskLevel): number {
  switch (riskLevel) {
    case "low":
      return 1.0;
    case "medium":
      return 0.5;
    case "high":
      return 0.1;
    case "unknown":
      return 0.3;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
