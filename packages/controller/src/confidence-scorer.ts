import type { UserIntent } from "@lhic/schema";

import type { StageClassification } from "./stage-classifier.js";

export function scoreConfidence(
  classification: StageClassification,
  intent: UserIntent,
): number {
  if (classification.stage === "unknown") {
    return 0.3;
  }
  if (classification.candidates.length > 1) {
    return 0.6;
  }
  if (intent.riskLevel === "unknown") {
    return 0.65;
  }
  return 0.9;
}
