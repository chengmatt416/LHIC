import type { SemanticAction, UserIntent } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type { SkillRecord } from "./skill-store.js";

export interface ComposableSkill {
  name: string;
  actions: SemanticAction[];
  preconditions?: string[];
  postconditions?: string[];
}

export interface CompositeSkill {
  name: string;
  steps: ComposableSkill[];
  totalActions: number;
  estimatedLatencyMs: number;
}

export interface CompositionResult {
  success: boolean;
  composite?: CompositeSkill;
  error?: string;
}

/**
 * Composes multiple simple skills into a complex workflow.
 * This allows building high-level skills from low-level primitives.
 */
export function composeSkills(
  skills: ComposableSkill[],
  goal: string,
): CompositionResult {
  if (skills.length === 0) {
    return { success: false, error: "No skills provided for composition." };
  }

  // Validate skill chain
  const validation = validateSkillChain(skills);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Calculate totals
  const totalActions = skills.reduce((sum, s) => sum + s.actions.length, 0);
  const estimatedLatencyMs = skills.reduce(
    (sum, s) => sum + estimateSkillLatency(s),
    0,
  );

  // Create composite name
  const name = createCompositeName(skills, goal);

  return {
    success: true,
    composite: {
      name,
      steps: skills,
      totalActions,
      estimatedLatencyMs,
    },
  };
}

/**
 * Validates that skills can be chained together.
 * Checks that postconditions of one skill match preconditions of the next.
 */
function validateSkillChain(
  skills: ComposableSkill[],
): { valid: boolean; error?: string } {
  for (let i = 0; i < skills.length - 1; i++) {
    const current = skills[i]!;
    const next = skills[i + 1]!;

    // Check postconditions → preconditions
    if (next.preconditions && next.preconditions.length > 0) {
      const postconditions = new Set(current.postconditions ?? []);
      const missing = next.preconditions.filter(
        (pre) => !postconditions.has(pre),
      );

      if (missing.length > 0) {
        return {
          valid: false,
          error: `Skill "${next.name}" requires preconditions not met by "${current.name}": ${missing.join(", ")}`,
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Creates a human-readable name for a composite skill.
 */
function createCompositeName(
  skills: ComposableSkill[],
  goal: string,
): string {
  const goalSlug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);

  const actionTypes = skills.flatMap((s) => s.actions.map((a) => a.type));
  const uniqueTypes = [...new Set(actionTypes)];

  return `composite-${goalSlug}-${uniqueTypes.join("-")}`.slice(0, 100);
}

/**
 * Estimates the latency of a skill based on its actions.
 */
function estimateSkillLatency(skill: ComposableSkill): number {
  const baseLatency: Record<string, number> = {
    navigate: 2000,
    click: 500,
    fill: 300,
    select: 400,
    press: 200,
    wait: 1000,
    download: 3000,
    os_click: 800,
    os_type: 500,
    os_press: 300,
    os_launch: 1500,
    os_focus: 500,
    os_screenshot: 200,
    os_observe: 1000,
    os_scroll: 300,
    os_clipboard: 100,
  };

  return skill.actions.reduce(
    (sum, action) => sum + (baseLatency[action.type] ?? 500),
    0,
  );
}

/**
 * Decomposes a complex intent into simpler sub-intents.
 * Each sub-intent can be handled by a single skill.
 */
export function decomposeIntent(
  intent: UserIntent,
  availableSkills: SkillRecord[],
): UserIntent[] {
  // Simple decomposition: split on conjunctions
  const goal = intent.goal.toLowerCase();
  const conjunctions = [" and ", " then ", " after ", " before "];

  for (const conjunction of conjunctions) {
    if (goal.includes(conjunction)) {
      const parts = intent.goal
        .split(new RegExp(conjunction, "i"))
        .map((s) => s.trim())
        .filter(Boolean);

      if (parts.length > 1) {
        return parts.map((part) => ({
          ...intent,
          goal: part,
          constraints: {}, // Reset constraints for sub-intents
        }));
      }
    }
  }

  // Single intent
  return [intent];
}

/**
 * Finds the best skill sequence to accomplish a goal.
 * Uses a greedy approach: at each step, pick the skill that
 * makes the most progress toward the goal.
 */
export function findSkillSequence(
  intent: UserIntent,
  availableSkills: SkillRecord[],
  maxSteps: number = 10,
): SkillRecord[] {
  const sequence: SkillRecord[] = [];
  let remainingGoal = intent.goal.toLowerCase();

  for (let i = 0; i < maxSteps; i++) {
    const bestSkill = findBestSkillForGoal(remainingGoal, availableSkills);
    if (!bestSkill) break;

    sequence.push(bestSkill);

    // Remove the portion of the goal this skill addresses
    const skillGoal = (
      (bestSkill.definition.goal as string) ?? ""
    ).toLowerCase();
    remainingGoal = remainingGoal.replace(skillGoal, "").trim();

    if (remainingGoal.length === 0) break;
  }

  return sequence;
}

/**
 * Finds the skill that best matches a goal.
 */
function findBestSkillForGoal(
  goal: string,
  skills: SkillRecord[],
): SkillRecord | undefined {
  const goalWords = goal.split(/\s+/).filter((w) => w.length > 2);
  let bestSkill: SkillRecord | undefined;
  let bestScore = 0;

  for (const skill of skills) {
    const skillGoal = ((skill.definition.goal as string) ?? "").toLowerCase();
    const skillWords = skillGoal.split(/\s+/).filter((w) => w.length > 2);

    const overlap = goalWords.filter((w) => skillWords.includes(w)).length;
    const score = overlap / Math.max(goalWords.length, 1);

    if (score > bestScore && score > 0.3) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  return bestSkill;
}
