import type { SemanticAction, ActionExecutionResult } from "@lhic/schema";

export interface ParallelAction {
  action: SemanticAction;
  index: number;
}

export interface ParallelExecutionResult {
  results: ActionExecutionResult[];
  totalLatencyMs: number;
  parallelismGain: number; // Ratio of sequential time to parallel time
}

export interface ActionExecutor {
  execute(action: SemanticAction): Promise<ActionExecutionResult>;
}

/**
 * Analyzes a sequence of actions and identifies which can be executed in parallel.
 * Actions are parallelizable if they:
 * 1. Don't depend on each other's results
 * 2. Don't modify the same target
 * 3. Are not high-risk (require sequential approval)
 */
export function analyzeParallelizability(
  actions: SemanticAction[],
): ParallelAction[][] {
  if (actions.length === 0) return [];

  const groups: ParallelAction[][] = [];
  let currentGroup: ParallelAction[] = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;

    // High-risk actions must be sequential
    if (action.riskLevel === "high" || action.riskLevel === "unknown") {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
        currentGroup = [];
      }
      groups.push([{ action, index: i }]);
      continue;
    }

    // Check if this action can join the current group
    const canParallelize = currentGroup.every((existing) =>
      canActionsParallelize(existing.action, action),
    );

    if (canParallelize) {
      currentGroup.push({ action, index: i });
    } else {
      if (currentGroup.length > 0) {
        groups.push(currentGroup);
      }
      currentGroup = [{ action, index: i }];
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Executes actions with optimal parallelism.
 * Groups independent actions and executes them concurrently.
 */
export async function executeWithParallelism(
  actions: SemanticAction[],
  executor: ActionExecutor,
): Promise<ParallelExecutionResult> {
  const groups = analyzeParallelizability(actions);
  const results: ActionExecutionResult[] = new Array(actions.length);
  const startedAt = performance.now();

  // Calculate what sequential time would have been
  let sequentialTimeEstimate = 0;

  for (const group of groups) {
    if (group.length === 1) {
      // Sequential execution
      const { action, index } = group[0]!;
      const result = await executor.execute(action);
      results[index] = result;
      sequentialTimeEstimate += result.latencyMs;
    } else {
      // Parallel execution
      const groupStartedAt = performance.now();
      const groupResults = await Promise.all(
        group.map(async ({ action, index }) => {
          const result = await executor.execute(action);
          return { result, index };
        }),
      );

      const groupLatency = performance.now() - groupStartedAt;

      for (const { result, index } of groupResults) {
        results[index] = result;
      }

      // Sequential time would have been sum of individual times
      const sequentialGroupTime = groupResults.reduce(
        (sum, { result }) => sum + result.latencyMs,
        0,
      );
      sequentialTimeEstimate += sequentialGroupTime;
    }
  }

  const totalLatencyMs = Math.round(performance.now() - startedAt);
  const parallelismGain =
    sequentialTimeEstimate > 0 ? sequentialTimeEstimate / totalLatencyMs : 1;

  return {
    results,
    totalLatencyMs,
    parallelismGain: Math.round(parallelismGain * 100) / 100,
  };
}

/**
 * Determines if two actions can be executed in parallel.
 */
function canActionsParallelize(a: SemanticAction, b: SemanticAction): boolean {
  // Same target cannot be parallelized (potential conflicts)
  if (a.target && b.target && a.target === b.target) {
    return false;
  }

  // Fill/press actions on the same element conflict
  if (
    (a.type === "fill" || a.type === "press") &&
    (b.type === "fill" || b.type === "press") &&
    a.target === b.target
  ) {
    return false;
  }

  // Navigation actions are sequential
  if (a.type === "navigate" || b.type === "navigate") {
    return false;
  }

  // Download actions are sequential
  if (a.type === "download" || b.type === "download") {
    return false;
  }

  // Global desktop actions are sequential
  if (a.scope === "os" || b.scope === "os") {
    return false;
  }

  return true;
}

/**
 * Calculates the optimal batch size for parallel execution.
 * Considers action complexity and resource constraints.
 */
export function calculateOptimalBatchSize(
  actions: SemanticAction[],
  maxConcurrency: number = 5,
): number {
  // Simple heuristic: batch size based on action types
  const hasComplexActions = actions.some(
    (a) => a.type === "download" || a.type === "navigate" || a.scope === "os",
  );

  if (hasComplexActions) return 1;
  return Math.min(maxConcurrency, actions.length);
}
