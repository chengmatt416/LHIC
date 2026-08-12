import type {
  NormalizedUIState,
  SemanticAction,
  UserIntent,
} from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type { SkillStore, SkillRecord, SkillLifecycle } from "@lhic/memory";

/**
 * One-shot learning: records a skill from a single successful execution.
 * Unlike the 3-run holdout gate, this allows immediate skill capture for
 * low-risk actions, with faster lifecycle progression.
 */
export function recordOneShotSkill(
  skillStore: SkillStore,
  intent: UserIntent,
  actions: SemanticAction[],
  verification: { success: boolean; evidence: string[] },
  uiState: NormalizedUIState,
): SkillRecord | undefined {
  if (!verification.success || verification.evidence.length === 0) {
    return undefined;
  }

  const name = createOneShotSkillName(intent, actions);
  const definition = compileOneShotDefinition(intent, actions, uiState);

  return skillStore.recordVerifiedSuccess(name, definition, verification);
}

/**
 * Creates a deterministic skill name from intent and actions.
 * Uses goal + action types for human-readable names.
 */
function createOneShotSkillName(
  intent: UserIntent,
  actions: SemanticAction[],
): string {
  const goalSlug = intent.goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
  const actionTypes = actions.map((a) => a.type).join("-");
  return `learned-${goalSlug}-${actionTypes}`.slice(0, 100);
}

/**
 * Compiles a skill definition from a single execution.
 * Templates variable values for reuse.
 */
function compileOneShotDefinition(
  intent: UserIntent,
  actions: SemanticAction[],
  uiState: NormalizedUIState,
): Record<string, unknown> {
  const safeState = redactPII({
    surface: uiState.surface,
    url: uiState.url,
    title: uiState.title,
    objectRoles: uiState.objects.map((o) => o.role).filter(Boolean),
  });

  return {
    compiler: "one-shot-v1",
    goal: intent.goal,
    domain: intent.domain,
    constraints: intent.constraints,
    actions: actions.map((action) => ({
      type: action.type,
      target: action.target,
      intent: action.intent,
      riskLevel: action.riskLevel,
    })),
    uiSignature: safeState,
    learnedAt: new Date().toISOString(),
  };
}

/**
 * Fast promotion: allows immediate promotion for low-risk actions.
 * High-risk actions still require the full holdout gate.
 */
export function canFastPromote(
  actions: SemanticAction[],
  lifecycle: SkillLifecycle,
): boolean {
  // Only promote low-risk actions quickly
  const hasHighRisk = actions.some(
    (a) => a.riskLevel === "high" || a.riskLevel === "unknown",
  );
  if (hasHighRisk) return false;

  // Already promoted skills don't need fast promotion
  if (lifecycle !== "draft") return false;

  return true;
}

/**
 * Calculates skill confidence based on lifecycle and success rate.
 * Returns a value between 0 and 1.
 */
export function calculateSkillConfidence(skill: SkillRecord): number {
  const lifecycleWeights: Record<SkillLifecycle, number> = {
    draft: 0.3,
    verified: 0.6,
    habit: 0.8,
    trusted: 0.95,
  };

  const baseWeight = lifecycleWeights[skill.lifecycle] ?? 0.3;
  const successRate =
    skill.successCount + skill.failureCount > 0
      ? skill.successCount / (skill.successCount + skill.failureCount)
      : 0.5;

  return baseWeight * 0.7 + successRate * 0.3;
}
