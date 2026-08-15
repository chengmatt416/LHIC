import type {
  NormalizedUIState,
  SemanticAction,
  UserIntent,
} from "@lhic/schema";
import { redactPII } from "@lhic/trace";

export type FailureReason =
  | "element_not_found"
  | "element_disabled"
  | "timeout"
  | "navigation_failed"
  | "verification_failed"
  | "approval_denied"
  | "unknown";

export interface FailureRecord {
  intent: UserIntent;
  action: SemanticAction;
  uiState: NormalizedUIState;
  reason: FailureReason;
  error: string | undefined;
  timestamp: string;
}

export interface FailurePattern {
  pattern: string;
  count: number;
  lastSeenAt: string;
  reasons: FailureReason[];
  suggestedWorkaround: string | undefined;
}

/**
 * Records and analyzes failures to avoid repeating them.
 * This is the "negative learning" complement to positive skill learning.
 */
export class FailureLearner {
  private readonly failures: FailureRecord[] = [];
  private readonly maxFailures: number;

  constructor(maxFailures: number = 1000) {
    this.maxFailures = maxFailures;
  }

  /**
   * Records a failure for future avoidance.
   */
  record(
    intent: UserIntent,
    action: SemanticAction,
    uiState: NormalizedUIState,
    reason: FailureReason,
    error?: string,
  ): void {
    // Evict oldest if at capacity
    if (this.failures.length >= this.maxFailures) {
      this.failures.shift();
    }

    this.failures.push({
      intent,
      action,
      uiState: redactPII(uiState) as NormalizedUIState,
      reason,
      error,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Checks if an action is likely to fail based on historical patterns.
   * Returns a confidence score (0-1) that the action will fail.
   */
  predictFailure(
    action: SemanticAction,
    uiState: NormalizedUIState,
  ): { likely: boolean; confidence: number; reason?: FailureReason } {
    const relevantFailures = this.failures.filter(
      (f) =>
        f.action.type === action.type &&
        f.action.target === action.target &&
        f.uiState.surface === uiState.surface,
    );

    if (relevantFailures.length === 0) {
      return { likely: false, confidence: 0 };
    }

    // Count failures by reason
    const reasonCounts = new Map<FailureReason, number>();
    for (const failure of relevantFailures) {
      reasonCounts.set(
        failure.reason,
        (reasonCounts.get(failure.reason) ?? 0) + 1,
      );
    }

    // Find most common reason
    let mostCommonReason: FailureReason = "unknown";
    let maxCount = 0;
    for (const [reason, count] of reasonCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        mostCommonReason = reason;
      }
    }

    const failureRate =
      relevantFailures.length / Math.max(this.failures.length, 1);
    const confidence = Math.min(0.95, failureRate * 2);

    return {
      likely: confidence > 0.3,
      confidence,
      reason: mostCommonReason,
    };
  }

  /**
   * Gets failure patterns for analysis and workaround suggestions.
   */
  getPatterns(): FailurePattern[] {
    const patterns = new Map<string, FailurePattern>();

    for (const failure of this.failures) {
      const key = `${failure.action.type}:${failure.action.target ?? "none"}`;
      const existing = patterns.get(key);

      if (existing) {
        existing.count++;
        existing.lastSeenAt = failure.timestamp;
        if (!existing.reasons.includes(failure.reason)) {
          existing.reasons.push(failure.reason);
        }
      } else {
        patterns.set(key, {
          pattern: key,
          count: 1,
          lastSeenAt: failure.timestamp,
          reasons: [failure.reason],
          suggestedWorkaround: suggestWorkaround(failure),
        });
      }
    }

    return Array.from(patterns.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 50); // Top 50 patterns
  }

  /**
   * Gets failure statistics.
   */
  stats(): {
    total: number;
    byReason: Record<FailureReason, number>;
    byActionType: Record<string, number>;
  } {
    const byReason: Record<string, number> = {};
    const byActionType: Record<string, number> = {};

    for (const failure of this.failures) {
      byReason[failure.reason] = (byReason[failure.reason] ?? 0) + 1;
      byActionType[failure.action.type] =
        (byActionType[failure.action.type] ?? 0) + 1;
    }

    return {
      total: this.failures.length,
      byReason: byReason as Record<FailureReason, number>,
      byActionType: byActionType as Record<string, number>,
    };
  }

  /**
   * Clears old failures beyond retention period.
   */
  prune(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const initialSize = this.failures.length;

    // Filter in-place using splice
    for (let i = this.failures.length - 1; i >= 0; i--) {
      if (new Date(this.failures[i]!.timestamp).getTime() <= cutoff) {
        this.failures.splice(i, 1);
      }
    }

    return initialSize - this.failures.length;
  }
}

function suggestWorkaround(failure: FailureRecord): string | undefined {
  switch (failure.reason) {
    case "element_not_found":
      return "Try using a different selector or waiting for the element to appear.";
    case "element_disabled":
      return "Wait for the element to become enabled or check prerequisites.";
    case "timeout":
      return "Increase timeout or check network connectivity.";
    case "navigation_failed":
      return "Verify URL is correct and accessible.";
    case "verification_failed":
      return "Check if the action had the expected effect.";
    default:
      return undefined;
  }
}

/**
 * Integrates failure learning with skill execution.
 * Checks if an action is likely to fail before executing it.
 */
export function shouldSkipAction(
  failureLearner: FailureLearner,
  action: SemanticAction,
  uiState: NormalizedUIState,
  threshold: number = 0.7,
): { skip: boolean; reason?: string } {
  const prediction = failureLearner.predictFailure(action, uiState);

  if (prediction.likely && prediction.confidence >= threshold) {
    return {
      skip: true,
      reason: `Action likely to fail (${prediction.reason}): ${(prediction.confidence * 100).toFixed(0)}% failure rate.`,
    };
  }

  return { skip: false };
}
