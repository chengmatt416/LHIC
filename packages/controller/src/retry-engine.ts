import type { ActionExecutionResult, SemanticAction } from "@lhic/schema";

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors: string[];
}

export interface RetryResult {
  result: ActionExecutionResult;
  attempts: number;
  totalLatencyMs: number;
  retried: boolean;
}

/**
 * Retry engine with exponential backoff and jitter.
 * Handles transient failures gracefully.
 */
export class RetryEngine {
  private readonly config: RetryConfig;

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = {
      maxRetries: config.maxRetries ?? 3,
      baseDelayMs: config.baseDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 30000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      retryableErrors: config.retryableErrors ?? [
        "timeout",
        "network",
        "element_not_found",
        "element_disabled",
        "navigation_failed",
      ],
    };
  }

  /**
   * Executes an action with retry logic.
   * Retries on transient failures with exponential backoff.
   */
  async executeWithRetry(
    action: SemanticAction,
    executor: (action: SemanticAction) => Promise<ActionExecutionResult>,
  ): Promise<RetryResult> {
    const startedAt = performance.now();
    let lastResult: ActionExecutionResult | undefined;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        lastResult = await executor(action);

        if (lastResult.success) {
          return {
            result: lastResult,
            attempts: attempt + 1,
            totalLatencyMs: Math.round(performance.now() - startedAt),
            retried: attempt > 0,
          };
        }

        // Check if error is retryable
        if (lastResult.error && !this.isRetryableError(lastResult.error)) {
          return {
            result: lastResult,
            attempts: attempt + 1,
            totalLatencyMs: Math.round(performance.now() - startedAt),
            retried: false,
          };
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (!this.isRetryableError(lastError.message)) {
          return {
            result: {
              success: false,
              latencyMs: Math.round(performance.now() - startedAt),
              evidence: [],
              error: lastError.message,
            },
            attempts: attempt + 1,
            totalLatencyMs: Math.round(performance.now() - startedAt),
            retried: false,
          };
        }
      }

      // Wait before retry (except on last attempt)
      if (attempt < this.config.maxRetries) {
        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    // All retries exhausted
    return {
      result: lastResult ?? {
        success: false,
        latencyMs: Math.round(performance.now() - startedAt),
        evidence: [],
        error: lastError?.message ?? "Max retries exceeded",
      },
      attempts: this.config.maxRetries + 1,
      totalLatencyMs: Math.round(performance.now() - startedAt),
      retried: true,
    };
  }

  /**
   * Checks if an error is retryable.
   */
  private isRetryableError(error: string): boolean {
    const lowerError = error.toLowerCase();
    return this.config.retryableErrors.some((retryable) =>
      lowerError.includes(retryable.toLowerCase()),
    );
  }

  /**
   * Calculates delay with exponential backoff and jitter.
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay =
      this.config.baseDelayMs *
      Math.pow(this.config.backoffMultiplier, attempt);

    // Add jitter (±25%)
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    const delay = exponentialDelay + jitter;

    return Math.min(delay, this.config.maxDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  }
}

/**
 * Circuit breaker: prevents cascading failures.
 * Opens after too many failures, closes after a cooldown period.
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: "closed" | "open" | "half-open" = "closed";

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly cooldownMs: number = 60000,
  ) {}

  /**
   * Executes a function with circuit breaker protection.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is open");
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = "open";
    }
  }

  /**
   * Gets the current circuit breaker state.
   */
  getState(): { state: string; failures: number; lastFailureTime: number } {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Manually resets the circuit breaker.
   */
  reset(): void {
    this.failures = 0;
    this.lastFailureTime = 0;
    this.state = "closed";
  }
}

/**
 * Timeout wrapper: adds timeout protection to async operations.
 */
export class TimeoutWrapper {
  /**
   * Wraps a promise with a timeout.
   */
  static async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    errorMessage: string = "Operation timed out",
  ): Promise<T> {
    const { promise: timeoutPromise, reject } = Promise.withResolvers<T>();

    const timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);

    try {
      const result = await Promise.race([promise, timeoutPromise]);
      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      clearTimeout(timeoutId);
      throw error;
    }
  }
}
