export interface GameFrameTiming {
  processingMs: number;
  sleepMs: number;
  frameMs: number;
  missedDeadline: boolean;
}

export interface GameRealtimeMetrics {
  targetFrameRateHz: number;
  targetFrameMs: number;
  frameCount: number;
  processingP50Ms: number;
  processingP95Ms: number;
  frameP95Ms: number;
  missedDeadlineCount: number;
  observedFrameRateHz: number;
}

export interface GameFramePacerOptions {
  now?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
}

/**
 * Maintains a maximum control rate without adding a full frame delay after
 * screenshot, policy inference, and input application have already run.
 */
export class GameFramePacer {
  readonly targetFrameMs: number;

  private readonly now: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly processingDurations: number[] = [];
  private readonly frameDurations: number[] = [];
  private firstFrameStartedAt: number | undefined;
  private lastFrameCompletedAt: number | undefined;
  private missedDeadlineCount = 0;

  constructor(
    readonly targetFrameRateHz: number,
    options: GameFramePacerOptions = {},
  ) {
    if (
      !Number.isFinite(targetFrameRateHz) ||
      targetFrameRateHz < 1 ||
      targetFrameRateHz > 120
    ) {
      throw new Error("Game frame rate must be between 1 and 120 Hz.");
    }
    this.targetFrameMs = 1_000 / targetFrameRateHz;
    this.now = options.now ?? performance.now.bind(performance);
    this.sleep =
      options.sleep ??
      ((durationMs) =>
        new Promise((resolveWait) => setTimeout(resolveWait, durationMs)));
  }

  startFrame(): number {
    return this.now();
  }

  async completeFrame(startedAt: number): Promise<GameFrameTiming> {
    const afterProcessing = this.now();
    const processingMs = nonNegativeDuration(afterProcessing - startedAt);
    const sleepMs = Math.max(0, this.targetFrameMs - processingMs);
    const missedDeadline = processingMs > this.targetFrameMs;
    if (sleepMs > 0) await this.sleep(sleepMs);
    const completedAt = this.now();
    const frameMs = nonNegativeDuration(completedAt - startedAt);

    this.processingDurations.push(processingMs);
    this.frameDurations.push(frameMs);
    if (this.firstFrameStartedAt === undefined) {
      this.firstFrameStartedAt = startedAt;
    }
    this.lastFrameCompletedAt = completedAt;
    if (missedDeadline) this.missedDeadlineCount += 1;

    return { processingMs, sleepMs, frameMs, missedDeadline };
  }

  metrics(): GameRealtimeMetrics {
    const frameCount = this.frameDurations.length;
    const elapsedMs =
      this.firstFrameStartedAt === undefined ||
      this.lastFrameCompletedAt === undefined
        ? 0
        : nonNegativeDuration(
            this.lastFrameCompletedAt - this.firstFrameStartedAt,
          );
    return {
      targetFrameRateHz: this.targetFrameRateHz,
      targetFrameMs: roundMetric(this.targetFrameMs),
      frameCount,
      processingP50Ms: percentile(this.processingDurations, 0.5),
      processingP95Ms: percentile(this.processingDurations, 0.95),
      frameP95Ms: percentile(this.frameDurations, 0.95),
      missedDeadlineCount: this.missedDeadlineCount,
      observedFrameRateHz:
        elapsedMs > 0 ? roundMetric((frameCount * 1_000) / elapsedMs) : 0,
    };
  }
}

function nonNegativeDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  );
  return roundMetric(sorted[index]!);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(3));
}
