import type { NormalizedUIState, UserIntent } from "@lhic/schema";

import { scoreConfidence } from "./confidence-scorer.js";
import { classifyStage, type ControllerStage } from "./stage-classifier.js";

export interface IntentPrediction {
  predictedIntent: ControllerStage;
  skillName?: string;
  confidence: number;
  evidence: string[];
}

const skillForStage: Partial<Record<ControllerStage, string>> = {
  login: "login",
  form_filling: "fill_form",
  search: "search",
  download: "download_file",
  test_web_flow: "test_web_flow",
};

export function predictIntent(
  intent: UserIntent,
  state: NormalizedUIState,
): IntentPrediction {
  const classification = classifyStage(intent, state);
  const skillName = skillForStage[classification.stage];
  return {
    predictedIntent: classification.stage,
    ...(skillName ? { skillName } : {}),
    confidence: scoreConfidence(classification, intent),
    evidence: classification.evidence,
  };
}
