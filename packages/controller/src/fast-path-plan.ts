import type {
  NormalizedUIState,
  SemanticAction,
  UserIntent,
} from "@lhic/schema";

import { compileActions, type CompileResult } from "./action-compiler.js";
import type { IntentPrediction } from "./predictor.js";
import type {
  ResolvedSharedSkill,
  SharedSkillResolver,
} from "./shared-skills.js";

export interface ResolvedFastPathPlan extends CompileResult {
  source: "builtin" | "shared";
  skillName?: string;
  sharedSkill?: ResolvedSharedSkill;
}

/** Resolves a local-only shared cache before falling back to built-in skills. */
export function resolveFastPathPlan(
  prediction: IntentPrediction,
  intent: UserIntent,
  uiState: NormalizedUIState,
  sharedSkillResolver?: SharedSkillResolver,
): ResolvedFastPathPlan {
  const sharedSkill = sharedSkillResolver?.resolve(intent, uiState);
  if (sharedSkill) {
    return {
      source: "shared",
      skillName: sharedSkill.skillName,
      sharedSkill,
      actions: sharedSkill.actions,
      missingInformation: [],
    };
  }
  const compiled = compileActions(prediction, intent);
  return {
    source: "builtin",
    ...(prediction.skillName ? { skillName: prediction.skillName } : {}),
    ...compiled,
  };
}

export function toRouteActions(plan: ResolvedFastPathPlan): SemanticAction[] {
  return plan.actions;
}
