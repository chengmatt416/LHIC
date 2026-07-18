import {
  defaultTaskBudgets,
  type ExecutionProfile,
  type TaskBudget,
  type TaskBudgetUsage,
} from "@lhic/schema";

export interface BudgetReservation {
  allowed: boolean;
  reason: string;
  usage: TaskBudgetUsage;
  remaining: TaskBudget;
}

export interface TaskBudgetTrackerOptions {
  budget?: Partial<TaskBudget>;
  now?: () => number;
}

/**
 * Enforces a task's capability budget locally. Its only mutable state is the
 * resource accounting for the current task; providers cannot grant themselves
 * additional calls, input, or time.
 */
export class TaskBudgetTracker {
  private readonly budget: TaskBudget;
  private readonly now: () => number;
  private readonly startedAt: number;
  private usage: Omit<TaskBudgetUsage, "wallClockMs"> = {
    slowPathCalls: 0,
    slowPathInputChars: 0,
    imageInputs: 0,
    slowPathLatencyMs: 0,
    stages: 0,
  };

  public constructor(
    profile: ExecutionProfile,
    options: TaskBudgetTrackerOptions = {},
  ) {
    this.budget = restrictBudget(defaultTaskBudgets[profile], options.budget);
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  public beginStage(): BudgetReservation {
    if (this.elapsedMs() > this.budget.maxWallClockMs) {
      return this.reject("The task wall-clock budget is exhausted.");
    }
    if (this.usage.stages >= this.budget.maxStages) {
      return this.reject("The task stage budget is exhausted.");
    }
    this.usage = { ...this.usage, stages: this.usage.stages + 1 };
    return this.allow("A controller stage was admitted.");
  }

  public reserveSlowPath(
    inputChars: number,
    imageInputs = 0,
  ): BudgetReservation {
    if (!Number.isSafeInteger(inputChars) || inputChars < 0) {
      return this.reject(
        "Slow Path input size must be a non-negative integer.",
      );
    }
    if (!Number.isSafeInteger(imageInputs) || imageInputs < 0) {
      return this.reject(
        "Slow Path image count must be a non-negative integer.",
      );
    }
    if (this.elapsedMs() > this.budget.maxWallClockMs) {
      return this.reject("The task wall-clock budget is exhausted.");
    }
    if (this.usage.slowPathCalls + 1 > this.budget.maxSlowPathCalls) {
      return this.reject("The task Slow Path call budget is exhausted.");
    }
    if (
      this.usage.slowPathInputChars + inputChars >
      this.budget.maxSlowPathInputChars
    ) {
      return this.reject("The task Slow Path input budget is exhausted.");
    }
    if (this.usage.imageInputs + imageInputs > this.budget.maxImageInputs) {
      return this.reject("The task image budget is exhausted.");
    }
    this.usage = {
      ...this.usage,
      slowPathCalls: this.usage.slowPathCalls + 1,
      slowPathInputChars: this.usage.slowPathInputChars + inputChars,
      imageInputs: this.usage.imageInputs + imageInputs,
    };
    return this.allow("A Slow Path request was admitted.");
  }

  public snapshot(): BudgetReservation {
    const exhausted = this.elapsedMs() > this.budget.maxWallClockMs;
    return exhausted
      ? this.reject("The task wall-clock budget is exhausted.")
      : this.allow("The task remains within budget.");
  }

  public recordSlowPathLatency(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
      throw new Error(
        "Slow Path latency must be a non-negative finite number.",
      );
    }
    this.usage = {
      ...this.usage,
      slowPathLatencyMs: this.usage.slowPathLatencyMs + Math.round(latencyMs),
    };
  }

  private allow(reason: string): BudgetReservation {
    return {
      allowed: true,
      reason,
      usage: this.currentUsage(),
      remaining: this.remaining(),
    };
  }

  private reject(reason: string): BudgetReservation {
    return {
      allowed: false,
      reason,
      usage: this.currentUsage(),
      remaining: this.remaining(),
    };
  }

  private currentUsage(): TaskBudgetUsage {
    return { ...this.usage, wallClockMs: this.elapsedMs() };
  }

  private remaining(): TaskBudget {
    return {
      maxSlowPathCalls: Math.max(
        0,
        this.budget.maxSlowPathCalls - this.usage.slowPathCalls,
      ),
      maxSlowPathInputChars: Math.max(
        0,
        this.budget.maxSlowPathInputChars - this.usage.slowPathInputChars,
      ),
      maxImageInputs: Math.max(
        0,
        this.budget.maxImageInputs - this.usage.imageInputs,
      ),
      maxStages: Math.max(0, this.budget.maxStages - this.usage.stages),
      maxWallClockMs: Math.max(
        0,
        this.budget.maxWallClockMs - this.elapsedMs(),
      ),
    };
  }

  private elapsedMs(): number {
    return Math.max(0, Math.round(this.now() - this.startedAt));
  }
}

function restrictBudget(
  defaults: TaskBudget,
  requested: Partial<TaskBudget> | undefined,
): TaskBudget {
  if (!requested) {
    return { ...defaults };
  }
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof TaskBudget>) {
    const limit = requested[key];
    if (limit === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new Error(`Task budget ${key} must be a non-negative integer.`);
    }
    if (limit > defaults[key]) {
      throw new Error(`Task budget ${key} cannot exceed the profile limit.`);
    }
    result[key] = limit;
  }
  return result;
}
