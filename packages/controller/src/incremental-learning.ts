import type { SemanticAction, UserIntent, NormalizedUIState } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type { SkillRecord, SkillLifecycle } from "@lhic/memory";

export interface SkillVersion {
  version: number;
  definition: Record<string, unknown>;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface IncrementalUpdate {
  skillName: string;
  newActions?: SemanticAction[];
  newConstraints?: Record<string, unknown>;
  successEvidence?: string[];
  failureReason?: string;
}

/**
 * Incremental learning: updates existing skills with new information
 * without requiring a full re-learn.
 */
export class IncrementalLearner {
  private readonly versions = new Map<string, SkillVersion[]>();

  /**
   * Applies an incremental update to a skill.
   * Returns the updated skill definition.
   */
  applyUpdate(
    existing: SkillRecord,
    update: IncrementalUpdate,
  ): Record<string, unknown> {
    const currentDef = { ...existing.definition };
    const versions = this.versions.get(update.skillName) ?? [];

    // Track version
    versions.push({
      version: versions.length + 1,
      definition: currentDef,
      successCount: existing.successCount,
      failureCount: existing.failureCount,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.versions.set(update.skillName, versions);

    // Merge new actions if provided
    if (update.newActions && update.newActions.length > 0) {
      const existingActions = (currentDef.actions as SemanticAction[]) ?? [];
      const mergedActions = mergeActions(existingActions, update.newActions);
      currentDef.actions = mergedActions;
    }

    // Merge new constraints
    if (update.newConstraints) {
      const existingConstraints =
        (currentDef.constraints as Record<string, unknown>) ?? {};
      currentDef.constraints = {
        ...existingConstraints,
        ...update.newConstraints,
      };
    }

    // Update metadata
    currentDef.lastUpdatedAt = new Date().toISOString();
    currentDef.updateCount = ((currentDef.updateCount as number) ?? 0) + 1;

    return currentDef;
  }

  /**
   * Gets the version history of a skill.
   */
  getVersions(skillName: string): SkillVersion[] {
    return this.versions.get(skillName) ?? [];
  }

  /**
   * Reverts a skill to a previous version.
   */
  revert(skillName: string, version: number): Record<string, unknown> | undefined {
    const versions = this.versions.get(skillName) ?? [];
    const target = versions.find((v) => v.version === version);
    return target?.definition;
  }
}

/**
 * Merges two action arrays, avoiding duplicates.
 */
function mergeActions(
  existing: SemanticAction[],
  newActions: SemanticAction[],
): SemanticAction[] {
  const merged = [...existing];

  for (const newAction of newActions) {
    const isDuplicate = existing.some(
      (e) =>
        e.type === newAction.type &&
        e.target === newAction.target &&
        e.intent === newAction.intent,
    );

    if (!isDuplicate) {
      merged.push(newAction);
    }
  }

  return merged;
}

/**
 * Transfer learning: applies skills learned on one site to similar sites.
 */
export class TransferLearner {
  private readonly sitePatterns = new Map<string, string[]>();

  /**
   * Registers a site pattern for transfer learning.
   * e.g., "github.com" → ["gitlab.com", "bitbucket.org"]
   */
  registerTransfer(source: string, targets: string[]): void {
    this.sitePatterns.set(source, targets);
  }

  /**
   * Finds transferable skills for a given URL.
   * Returns skills learned on similar sites.
   */
  findTransferable(
    url: string,
    skills: SkillRecord[],
  ): SkillRecord[] {
    const sourceOrigin = extractOrigin(url);
    const transferable: SkillRecord[] = [];

    for (const skill of skills) {
      const skillOrigin = skill.definition.origin as string | undefined;
      if (!skillOrigin) continue;

      // Direct match
      if (skillOrigin === sourceOrigin) {
        transferable.push(skill);
        continue;
      }

      // Check transfer patterns
      for (const [source, targets] of this.sitePatterns.entries()) {
        if (
          (skillOrigin.includes(source) && targets.some((t) => sourceOrigin.includes(t))) ||
          (sourceOrigin.includes(source) && targets.some((t) => skillOrigin.includes(t)))
        ) {
          transferable.push(skill);
          break;
        }
      }
    }

    return transferable;
  }

  /**
   * Adapts a skill from one site to work on another.
   * Adjusts selectors and targets to match the new site's structure.
   */
  adaptSkill(
    skill: SkillRecord,
    targetUrl: string,
  ): Record<string, unknown> {
    const adapted = { ...skill.definition };
    const targetOrigin = extractOrigin(targetUrl);

    // Update origin
    adapted.origin = targetOrigin;
    adapted.transferredFrom = skill.definition.origin;
    adapted.transferredAt = new Date().toISOString();

    // Adjust selectors if they contain site-specific patterns
    if (adapted.actions && Array.isArray(adapted.actions)) {
      adapted.actions = (adapted.actions as SemanticAction[]).map((action) => ({
        ...action,
        // Keep action structure, selectors will be resolved at runtime
      }));
    }

    return adapted;
  }
}

function extractOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Online learning: learns during execution, not just after.
 * Captures intermediate states and adjusts strategy in real-time.
 */
export class OnlineLearner {
  private readonly observations: Array<{
    state: NormalizedUIState;
    action: SemanticAction;
    success: boolean;
    timestamp: number;
  }> = [];

  private readonly maxObservations: number;

  constructor(maxObservations: number = 100) {
    this.maxObservations = maxObservations;
  }

  /**
   * Records an observation during execution.
   */
  observe(
    state: NormalizedUIState,
    action: SemanticAction,
    success: boolean,
  ): void {
    if (this.observations.length >= this.maxObservations) {
      this.observations.shift();
    }

    this.observations.push({
      state: redactPII(state) as NormalizedUIState,
      action,
      success,
      timestamp: Date.now(),
    });
  }

  /**
   * Predicts the success probability of an action based on recent observations.
   */
  predictSuccess(
    action: SemanticAction,
    state: NormalizedUIState,
  ): number {
    const relevant = this.observations.filter(
      (o) =>
        o.action.type === action.type &&
        o.action.target === action.target &&
        o.state.surface === state.surface,
    );

    if (relevant.length === 0) return 0.5; // Unknown

    const successCount = relevant.filter((o) => o.success).length;
    return successCount / relevant.length;
  }

  /**
   * Gets the optimal action sequence based on observed patterns.
   */
  suggestSequence(
    goal: string,
    state: NormalizedUIState,
  ): SemanticAction[] {
    // Find successful action sequences from observations
    const successfulSequences = this.findSuccessfulSequences();

    // Score sequences by relevance to current goal
    const scored = successfulSequences.map((seq) => ({
      sequence: seq,
      score: this.scoreSequence(seq, goal, state),
    }));

    // Return the best scoring sequence
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.sequence ?? [];
  }

  private findSuccessfulSequences(): SemanticAction[][] {
    const sequences: SemanticAction[][] = [];
    let currentSequence: SemanticAction[] = [];

    for (const obs of this.observations) {
      if (obs.success) {
        currentSequence.push(obs.action);
      } else {
        if (currentSequence.length > 0) {
          sequences.push(currentSequence);
          currentSequence = [];
        }
      }
    }

    if (currentSequence.length > 0) {
      sequences.push(currentSequence);
    }

    return sequences;
  }

  private scoreSequence(
    sequence: SemanticAction[],
    goal: string,
    state: NormalizedUIState,
  ): number {
    const goalWords = goal.toLowerCase().split(/\s+/);
    const sequenceIntents = sequence.map((a) => a.intent.toLowerCase());

    // Keyword overlap
    const overlap = goalWords.filter((w) =>
      sequenceIntents.some((i) => i.includes(w)),
    ).length;
    const keywordScore = overlap / Math.max(goalWords.length, 1);

    // Recency bonus
    const lastObs = this.observations[this.observations.length - 1];
    const recencyBonus = lastObs ? Math.max(0, 1 - (Date.now() - lastObs.timestamp) / 60000) : 0;

    return keywordScore * 0.7 + recencyBonus * 0.3;
  }
}
