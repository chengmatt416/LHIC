import type {
  NormalizedUIState,
  SemanticAction,
  UserIntent,
} from "@lhic/schema";
import { isBrowserSemanticAction } from "@lhic/schema";
import { redactPII } from "@lhic/trace";

import type { IntentPrediction } from "./predictor.js";
import type {
  SlowPathProvider,
  SlowPathRequest,
  SlowPathResponse,
} from "./slow-path.js";
import { toSlowPathSafeUiState } from "./slow-path.js";
import type { TaskBudgetTracker } from "./task-budget.js";

/**
 * A cached LLM response for a specific intent+UI state combination.
 * Enables "learn once, replay instantly" behavior.
 */
interface CachedLLMPlan {
  actions: SemanticAction[];
  cachedAt: number;
  hitCount: number;
  goal: string;
  uiFingerprint: string;
}

/**
 * Hybrid Fast Path: can optionally call LLM for complex tasks while
 * maintaining speed advantages through caching and parallel execution.
 *
 * Architecture:
 *  1. Check skill cache (instant, zero LLM)
 *  2. Check learned skills from memory (instant, zero LLM)
 *  3. If complex task → make ONE fast LLM call → cache result
 *  4. Execute cached plan with parallel execution engine
 *
 * This replaces the old "blocked" path with an intelligent fallback.
 */
export class HybridFastPathRouter {
  private readonly llmCache = new Map<string, CachedLLMPlan>();
  private readonly cacheTtlMs: number;
  private readonly maxCacheSize: number;

  constructor(
    private readonly slowPathProvider?: SlowPathProvider,
    options: { cacheTtlMs?: number; maxCacheSize?: number } = {},
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 30 * 60 * 1000; // 30 min default
    this.maxCacheSize = options.maxCacheSize ?? 500;
  }

  /**
   * Routes a task through the hybrid fast path.
   * Returns actions from cache, skill, or a single LLM call.
   */
  async route(
    prediction: IntentPrediction,
    intent: UserIntent,
    uiState: NormalizedUIState,
    budget?: TaskBudgetTracker,
  ): Promise<HybridRouteResult> {
    // Step 1: Check LLM cache (instant)
    const cacheKey = this.computeCacheKey(intent, uiState);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return {
        source: "cache",
        actions: cached.actions,
        llmCalls: 0,
        latencyMs: 0,
        cacheHit: true,
      };
    }

    // Step 2: High confidence → no LLM needed
    if (prediction.confidence >= 0.8 && prediction.skillName) {
      return {
        source: "skill",
        actions: [], // Will be resolved by caller
        llmCalls: 0,
        latencyMs: 0,
        cacheHit: false,
        skillName: prediction.skillName,
      };
    }

    // Step 3: Complex task → single LLM call
    if (!this.slowPathProvider) {
      return {
        source: "blocked",
        actions: [],
        llmCalls: 0,
        latencyMs: 0,
        cacheHit: false,
        error: "No LLM provider available for complex tasks.",
      };
    }

    // Check budget
    if (budget) {
      const reservation = budget.reserveSlowPath(
        JSON.stringify(intent).length + JSON.stringify(uiState).length,
        0,
      );
      if (!reservation.allowed) {
        return {
          source: "blocked",
          actions: [],
          llmCalls: 0,
          latencyMs: 0,
          cacheHit: false,
          error: "Task budget exhausted.",
        };
      }
    }

    // Make ONE LLM call
    const startedAt = performance.now();
    const response = await this.callLLM(intent, uiState);
    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response || response.decision === "blocked") {
      return {
        source: "blocked",
        actions: [],
        llmCalls: 1,
        latencyMs,
        cacheHit: false,
        error: response?.message ?? "LLM returned no actionable plan.",
      };
    }

    const actions = (response.proposedActions ?? []).filter(
      isBrowserSemanticAction,
    );

    if (actions.length === 0) {
      return {
        source: "blocked",
        actions: [],
        llmCalls: 1,
        latencyMs,
        cacheHit: false,
        error: "LLM proposed no valid browser actions.",
      };
    }

    // Cache the result for future instant replay
    this.putInCache(cacheKey, {
      actions,
      cachedAt: Date.now(),
      hitCount: 0,
      goal: intent.goal,
      uiFingerprint: this.computeUIFingerprint(uiState),
    });

    return {
      source: "llm",
      actions,
      llmCalls: 1,
      latencyMs,
      cacheHit: false,
    };
  }

  /**
   * Makes a single LLM call with a compact, redacted request.
   */
  private async callLLM(
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): Promise<SlowPathResponse | undefined> {
    if (!this.slowPathProvider) return undefined;

    const safeUiState = toSlowPathSafeUiState(
      redactPII(uiState) as NormalizedUIState,
    );

    const request: SlowPathRequest = {
      taskId: `hybrid-${Date.now()}`,
      userIntent: redactPII(intent) as UserIntent,
      uiState: safeUiState,
      recentTrace: [],
      reason: "low_confidence",
    };

    try {
      return await this.slowPathProvider.reason(request);
    } catch {
      return undefined;
    }
  }

  /**
   * Computes a cache key from intent and UI state.
   * Uses semantic similarity, not exact match, for better cache hits.
   */
  private computeCacheKey(
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): string {
    const goalWords = intent.goal
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .sort()
      .join("-");
    const surface = uiState.surface;
    const objectTypes = uiState.objects
      .map((o) => o.role ?? "")
      .filter(Boolean)
      .sort()
      .join("-");
    return `${goalWords}::${surface}::${objectTypes}`;
  }

  private computeUIFingerprint(uiState: NormalizedUIState): string {
    return uiState.objects
      .map((o) => o.role ?? "")
      .sort()
      .join("|");
  }

  private getFromCache(key: string): CachedLLMPlan | undefined {
    const entry = this.llmCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > this.cacheTtlMs) {
      this.llmCache.delete(key);
      return undefined;
    }
    entry.hitCount++;
    return entry;
  }

  private putInCache(key: string, plan: CachedLLMPlan): void {
    if (this.llmCache.size >= this.maxCacheSize) {
      // Evict least recently used
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of this.llmCache.entries()) {
        if (v.cachedAt < oldestTime) {
          oldestTime = v.cachedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.llmCache.delete(oldestKey);
    }
    this.llmCache.set(key, plan);
  }

  /**
   * Returns cache statistics for monitoring.
   */
  getCacheStats(): { size: number; totalHits: number; hitRate: number } {
    let totalHits = 0;
    for (const entry of this.llmCache.values()) {
      totalHits += entry.hitCount;
    }
    return {
      size: this.llmCache.size,
      totalHits,
      hitRate:
        this.llmCache.size > 0
          ? totalHits / (totalHits + this.llmCache.size)
          : 0,
    };
  }

  /**
   * Clears the cache. Useful for testing or after UI changes.
   */
  clearCache(): void {
    this.llmCache.clear();
  }
}

export interface HybridRouteResult {
  source: "cache" | "skill" | "llm" | "blocked";
  actions: SemanticAction[];
  llmCalls: 0 | 1;
  latencyMs: number;
  cacheHit: boolean;
  skillName?: string;
  error?: string;
}
