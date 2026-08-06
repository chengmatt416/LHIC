import type {
  ActionExecutionResult,
  NormalizedUIState,
  SemanticAction,
  UserIntent,
} from "@lhic/schema";

import type { SkillRecord } from "@lhic/memory";
import type { CachedSkill } from "./skill-cache.js";

export interface PrefetchConfig {
  maxPrefetchSize: number;
  prefetchThreshold: number;
  warmupEnabled: boolean;
}

export interface PrefetchResult {
  prefetched: SkillRecord[];
  warmupTimeMs: number;
}

/**
 * Prefetching engine: anticipates next actions and pre-loads resources.
 * Reduces latency by preparing skills before they're needed.
 */
export class PrefetchEngine {
  private readonly prefetched = new Map<string, SkillRecord>();
  private readonly config: PrefetchConfig;

  constructor(config: Partial<PrefetchConfig> = {}) {
    this.config = {
      maxPrefetchSize: config.maxPrefetchSize ?? 50,
      prefetchThreshold: config.prefetchThreshold ?? 0.6,
      warmupEnabled: config.warmupEnabled ?? true,
    };
  }

  /**
   * Prefetches skills that are likely to be needed next.
   * Based on current intent and UI state.
   */
  async prefetch(
    intent: UserIntent,
    state: NormalizedUIState,
    availableSkills: SkillRecord[],
  ): Promise<PrefetchResult> {
    const startedAt = performance.now();
    const candidates = this.scoreCandidates(intent, state, availableSkills);

    // Take top N candidates
    const toPrefetch = candidates
      .filter((c) => c.score >= this.config.prefetchThreshold)
      .slice(0, this.config.maxPrefetchSize);

    // Store in prefetch cache
    for (const candidate of toPrefetch) {
      this.prefetched.set(candidate.skill.name, candidate.skill);
    }

    // Warmup: pre-compile skill definitions
    if (this.config.warmupEnabled) {
      await this.warmup(toPrefetch.map((c) => c.skill));
    }

    return {
      prefetched: toPrefetch.map((c) => c.skill),
      warmupTimeMs: Math.round(performance.now() - startedAt),
    };
  }

  /**
   * Gets a prefetched skill if available.
   */
  get(name: string): SkillRecord | undefined {
    const skill = this.prefetched.get(name);
    if (skill) {
      this.prefetched.delete(name); // Consume
    }
    return skill;
  }

  /**
   * Checks if a skill is prefetched.
   */
  has(name: string): boolean {
    return this.prefetched.has(name);
  }

  /**
   * Clears the prefetch cache.
   */
  clear(): void {
    this.prefetched.clear();
  }

  /**
   * Gets prefetch statistics.
   */
  stats(): { size: number; hitRate: number } {
    return {
      size: this.prefetched.size,
      hitRate: 0, // TODO: track hits
    };
  }

  private scoreCandidates(
    intent: UserIntent,
    state: NormalizedUIState,
    skills: SkillRecord[],
  ): Array<{ skill: SkillRecord; score: number }> {
    const intentKeywords = extractKeywords(intent.goal);
    const surface = state.surface;

    return skills.map((skill) => {
      const skillGoal = (skill.definition.goal as string) ?? "";
      const skillKeywords = extractKeywords(skillGoal);
      const skillSurface = skill.definition.surface as string | undefined;

      // Keyword overlap
      const overlap = intentKeywords.filter((k) =>
        skillKeywords.includes(k),
      ).length;
      const keywordScore = overlap / Math.max(intentKeywords.length, 1);

      // Surface match
      const surfaceScore = skillSurface === surface ? 0.3 : 0;

      // Lifecycle bonus (trusted skills are more likely to be useful)
      const lifecycleScore =
        skill.lifecycle === "trusted"
          ? 0.2
          : skill.lifecycle === "habit"
            ? 0.1
            : 0;

      return {
        skill,
        score: keywordScore * 0.5 + surfaceScore + lifecycleScore,
      };
    });
  }

  private async warmup(skills: SkillRecord[]): Promise<void> {
    // Pre-compile JSON definitions
    for (const skill of skills) {
      try {
        JSON.stringify(skill.definition);
      } catch {
        // Ignore invalid definitions
      }
    }
  }
}

/**
 * Streaming execution: starts executing before all actions are planned.
 * Reduces time-to-first-action.
 */
export class StreamingExecutor {
  private readonly actionQueue: Array<{
    action: SemanticAction;
    resolve: (result: ActionExecutionResult) => void;
    reject: (error: Error) => void;
  }> = [];

  private executing = false;

  /**
   * Enqueues an action for streaming execution.
   * Returns a promise that resolves when the action completes.
   */
  enqueue(action: SemanticAction): Promise<ActionExecutionResult> {
    const { promise, resolve, reject } =
      Promise.withResolvers<ActionExecutionResult>();
    this.actionQueue.push({ action, resolve, reject });
    this.processNext();
    return promise;
  }

  /**
   * Processes the next action in the queue.
   */
  private async processNext(): Promise<void> {
    if (this.executing || this.actionQueue.length === 0) return;

    this.executing = true;
    const item = this.actionQueue.shift()!;

    try {
      // Simulate execution (in real implementation, call the executor)
      const result: ActionExecutionResult = {
        success: true,
        latencyMs: 0,
        evidence: ["Streaming execution placeholder"],
      };
      item.resolve(result);
    } catch (error) {
      item.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      this.executing = false;
      this.processNext();
    }
  }

  /**
   * Gets the queue length.
   */
  get queueLength(): number {
    return this.actionQueue.length;
  }

  /**
   * Clears the queue.
   */
  clear(): void {
    for (const item of this.actionQueue) {
      item.reject(new Error("Queue cleared"));
    }
    this.actionQueue.length = 0;
  }
}

/**
 * Adaptive thresholds: dynamically adjusts confidence thresholds
 * based on observed success rates.
 */
export class AdaptiveThresholds {
  private successRates = new Map<string, number[]>();
  private readonly windowSize: number;

  constructor(windowSize: number = 100) {
    this.windowSize = windowSize;
  }

  /**
   * Records a success/failure for threshold adjustment.
   */
  record(context: string, success: boolean): void {
    const rates = this.successRates.get(context) ?? [];
    rates.push(success ? 1 : 0);

    // Keep only recent observations
    if (rates.length > this.windowSize) {
      rates.shift();
    }

    this.successRates.set(context, rates);
  }

  /**
   * Gets the adaptive threshold for a context.
   * Higher success rates → lower threshold (more aggressive).
   * Lower success rates → higher threshold (more conservative).
   */
  getThreshold(context: string, baseThreshold: number = 0.8): number {
    const rates = this.successRates.get(context) ?? [];
    if (rates.length < 10) return baseThreshold; // Not enough data

    const successRate = rates.reduce((a, b) => a + b, 0) / rates.length;

    // Adjust threshold based on success rate
    // High success rate (0.9+) → threshold 0.6-0.7
    // Medium success rate (0.5-0.9) → threshold 0.7-0.8
    // Low success rate (<0.5) → threshold 0.8-0.9
    const adjustment = (1 - successRate) * 0.3;
    return Math.min(0.95, Math.max(0.5, baseThreshold - adjustment));
  }

  /**
   * Gets statistics for all contexts.
   */
  stats(): Record<string, { count: number; successRate: number; threshold: number }> {
    const result: Record<string, { count: number; successRate: number; threshold: number }> = {};

    for (const [context, rates] of this.successRates.entries()) {
      const successRate = rates.reduce((a, b) => a + b, 0) / rates.length;
      result[context] = {
        count: rates.length,
        successRate: Math.round(successRate * 100) / 100,
        threshold: this.getThreshold(context),
      };
    }

    return result;
  }
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}
