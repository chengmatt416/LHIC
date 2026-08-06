import type { NormalizedUIState, SemanticAction, UserIntent } from "@lhic/schema";

import type { SkillRecord } from "./skill-store.js";
import { calculateSkillConfidence } from "./one-shot-learning.js";

export interface CachedSkill {
  skill: SkillRecord;
  confidence: number;
  lastUsedAt: number;
  useCount: number;
}

export interface SkillCacheOptions {
  maxSize?: number;
  ttlMs?: number;
}

/**
 * LRU skill cache with confidence-based eviction.
 * Keeps the most relevant skills in memory for fast retrieval.
 */
export class SkillCache {
  private readonly cache = new Map<string, CachedSkill>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: SkillCacheOptions = {}) {
    this.maxSize = options.maxSize ?? 1000;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000; // 24 hours
  }

  /**
   * Gets a skill from cache, updating its LRU position.
   */
  get(name: string): CachedSkill | undefined {
    const cached = this.cache.get(name);
    if (!cached) return undefined;

    // Check TTL
    if (Date.now() - cached.lastUsedAt > this.ttlMs) {
      this.cache.delete(name);
      return undefined;
    }

    // Update LRU position
    this.cache.delete(name);
    this.cache.set(name, { ...cached, lastUsedAt: Date.now(), useCount: cached.useCount + 1 });
    return cached;
  }

  /**
   * Puts a skill into cache, evicting if necessary.
   */
  put(skill: SkillRecord): void {
    // Evict if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictLeastRelevant();
    }

    const confidence = calculateSkillConfidence(skill);
    this.cache.set(skill.name, {
      skill,
      confidence,
      lastUsedAt: Date.now(),
      useCount: 0,
    });
  }

  /**
   * Finds the best matching skill for a given intent and UI state.
   * Uses a simple heuristic: match on goal keywords and UI surface.
   */
  findBestMatch(
    intent: UserIntent,
    uiState: NormalizedUIState,
  ): CachedSkill | undefined {
    const intentKeywords = extractKeywords(intent.goal);
    let bestMatch: CachedSkill | undefined;
    let bestScore = 0;

    for (const cached of this.cache.values()) {
      // Check TTL
      if (Date.now() - cached.lastUsedAt > this.ttlMs) continue;

      const skillDef = cached.skill.definition;
      const skillGoal = (skillDef.goal as string) ?? "";
      const skillKeywords = extractKeywords(skillGoal);

      // Calculate keyword overlap score
      const overlap = intentKeywords.filter((k) => skillKeywords.includes(k)).length;
      const keywordScore = overlap / Math.max(intentKeywords.length, 1);

      // UI surface bonus
      const surfaceMatch = (skillDef.surface as string) === uiState.surface ? 0.2 : 0;

      // Confidence bonus
      const confidenceBonus = cached.confidence * 0.3;

      // Recency bonus (prefer recently used skills)
      const ageMs = Date.now() - cached.lastUsedAt;
      const recencyBonus = Math.max(0, 1 - ageMs / this.ttlMs) * 0.1;

      const totalScore = keywordScore * 0.4 + surfaceMatch + confidenceBonus + recencyBonus;

      if (totalScore > bestScore && totalScore > 0.3) {
        bestScore = totalScore;
        bestMatch = cached;
      }
    }

    return bestMatch;
  }

  /**
   * Returns cache statistics.
   */
  stats(): { size: number; hitRate: number } {
    const totalUses = Array.from(this.cache.values()).reduce((sum, c) => sum + c.useCount, 0);
    return {
      size: this.cache.size,
      hitRate: totalUses > 0 ? this.cache.size / totalUses : 0,
    };
  }

  /**
   * Clears expired entries.
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, cached] of this.cache.entries()) {
      if (now - cached.lastUsedAt > this.ttlMs) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  private evictLeastRelevant(): void {
    // Find the entry with lowest relevance score
    let leastRelevant: string | undefined;
    let lowestScore = Infinity;

    for (const [key, cached] of this.cache.entries()) {
      const ageMs = Date.now() - cached.lastUsedAt;
      const recencyScore = 1 - ageMs / this.ttlMs;
      const score = cached.confidence * 0.6 + recencyScore * 0.4;

      if (score < lowestScore) {
        lowestScore = score;
        leastRelevant = key;
      }
    }

    if (leastRelevant) {
      this.cache.delete(leastRelevant);
    }
  }
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 2);
}
