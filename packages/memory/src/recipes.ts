import { randomUUID } from "node:crypto";

import type { SemanticAction, VerifiedRecipe } from "@lhic/schema";
import { inferSideEffectClass } from "@lhic/security";
import { hashState, redactPII } from "@lhic/trace";

import type { SkillStore } from "./skill-store.js";

export interface RecipeExtractionOptions {
  /** Minimum independent verified runs (distinct task IDs). */
  minIndependentRuns?: number;
}

/**
 * Verified recipe extraction. A recipe candidate exists only after repeated
 * INDEPENDENT verifier-backed successes (distinct task IDs) plus a passed
 * holdout. The same task ID repeated never counts as independent evidence
 * (candidate runs dedupe by task ID). Extraction is suggested from evidence;
 * recipe execution still goes through policy, and parameterization strips
 * PII/secrets.
 */
export function extractRecipeCandidate(
  skillStore: SkillStore,
  candidateName: string,
  options: RecipeExtractionOptions = {},
): VerifiedRecipe | undefined {
  const candidate = skillStore.getCandidate(candidateName);
  if (!candidate) return undefined;
  const minRuns = options.minIndependentRuns ?? 3;
  if (!candidate.holdoutPassed) return undefined;
  const taskIds = skillStore.candidateRunTaskIds(candidateName);
  if (taskIds.length < minRuns) return undefined;

  const definition = candidate.definition as {
    goal?: unknown;
    constraints?: Record<string, unknown>;
    actions?: SemanticAction[];
    templateVariables?: string[];
  };
  if (
    typeof definition.goal !== "string" ||
    !Array.isArray(definition.actions)
  ) {
    return undefined;
  }

  const parameters = (definition.templateVariables ?? [])
    .filter((variable): variable is string => typeof variable === "string")
    .map((name) => ({ name: name.replace(/^constraints\./, "") }));

  const riskClasses = [
    ...new Set(
      definition.actions.map((action) => inferSideEffectClass(action)),
    ),
  ];

  const steps = definition.actions.map((action) => ({
    action: redactPII(action),
    verification: {},
  }));

  const recipe: VerifiedRecipe = {
    schemaVersion: "lhic-recipe-v1",
    recipeId: randomUUID(),
    goal: definition.goal,
    parameters,
    steps,
    risk: { classes: riskClasses },
    evidence: {
      independentRuns: taskIds.length,
      holdoutPassed: true,
      sourceTaskIds: taskIds,
    },
    definitionSha256: candidate.definitionSha256,
    version: "1.0.0",
    createdAt: new Date().toISOString(),
  };

  // Parameterization must never leak literal secrets: redact the serialized
  // recipe and refuse extraction when credential-like literals remain.
  const redacted = redactPII(recipe);
  const serialized = JSON.stringify(redacted);
  if (
    /[A-Za-z0-9+/]{32,}={0,2}/.test(serialized) &&
    /secret|token|key|password/i.test(serialized)
  ) {
    return undefined;
  }
  return redacted as VerifiedRecipe;
}

/** Stable recipe fingerprint: the definition hash plus evidence identity. */
export function recipeFingerprint(recipe: VerifiedRecipe): string {
  return hashState({
    goal: recipe.goal,
    definitionSha256: recipe.definitionSha256,
    independentRuns: recipe.evidence.independentRuns,
    holdoutPassed: recipe.evidence.holdoutPassed,
  });
}
