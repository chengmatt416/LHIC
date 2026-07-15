import type { NormalizedUIState, UserIntent } from "@lhic/schema";

import type { StageClassification } from "./stage-classifier.js";

/**
 * Score confidence that the predicted stage matches the user's intent.
 *
 * The scoring is purely deterministic — no LLM calls, no MCP, no external
 * services. It considers:
 * - Whether the stage is known
 * - Number of candidate stages (ambiguity penalty)
 * - Intent risk level (unknown risk → lower confidence)
 * - UI element presence (more matching elements → higher confidence)
 * - Precision of the match between intent and UI state
 */
export function scoreConfidence(
  classification: StageClassification,
  intent: UserIntent,
  state?: NormalizedUIState,
): number {
  // Unknown stage: low confidence
  if (classification.stage === "unknown") {
    return 0.3;
  }

  let confidence = 0.9; // baseline for a known, clear stage

  // Penalise ambiguity: more candidates = lower confidence
  if (classification.candidates.length > 1) {
    confidence -= 0.15 * (classification.candidates.length - 1);
  }

  // Penalise unknown risk
  if (intent.riskLevel === "unknown") {
    confidence -= 0.2;
  }

  // Bonus: UI elements match the intent
  if (state && intent.domain) {
    // Having a matching domain and UI state boosts confidence
    if (
      state.objects &&
      state.objects.length > 0
    ) {
      confidence += 0.05;
    }
  }

  // Bonus: clear, specific goal text
  if (intent.goal && intent.goal.length > 10) {
    confidence += 0.02;
  }

  // Clamp to [0.0, 1.0]
  return Math.max(0.0, Math.min(1.0, confidence));
}
