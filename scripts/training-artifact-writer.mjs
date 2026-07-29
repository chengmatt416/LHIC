import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Structured Training Artifact Writer
 *
 * Writes training results into a structured directory layout on the VM
 * that gets synced to GitHub's `training-results` branch.
 *
 * Directory layout:
 *   .lhic/training-artifacts/
 *   ├── daily/YYYY-MM-DD/iteration-NNN.json
 *   ├── daily/YYYY-MM-DD/summary.json
 *   ├── metrics/pytorch-loss.jsonl
 *   ├── metrics/pytorch-accuracy.jsonl
 *   ├── metrics/resilience-delta.jsonl
 *   ├── metrics/task-throughput.jsonl
 *   ├── skills/YYYY-MM-DD/candidates.json
 *   ├── benchmarks/YYYY-MM-DD/results.json
 *   └── latest/status.json + recent.log
 */

export class TrainingArtifactWriter {
  constructor(rootDir) {
    this.artifactsDir = join(rootDir, ".lhic", "training-artifacts");
    this.metricsDir = join(this.artifactsDir, "metrics");
    this.latestDir = join(this.artifactsDir, "latest");
    this._ensureDirs();
  }

  _ensureDirs() {
    mkdirSync(this.artifactsDir, { recursive: true });
    mkdirSync(this.metricsDir, { recursive: true });
    mkdirSync(this.latestDir, { recursive: true });
  }

  _today() {
    return new Date().toISOString().slice(0, 10);
  }

  _dailyDir(date) {
    const dir = join(this.artifactsDir, "daily", date || this._today());
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  _skillsDir(date) {
    const dir = join(this.artifactsDir, "skills", date || this._today());
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  _benchmarksDir(date) {
    const dir = join(this.artifactsDir, "benchmarks", date || this._today());
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Write a structured iteration result to daily/ and append to metrics/ time series.
   */
  writeIterationResult(result) {
    const date = this._today();
    const dir = this._dailyDir(date);

    // Per-iteration file
    const iterFile = join(dir, `iteration-${String(result.iteration).padStart(5, "0")}.json`);
    writeFileSync(iterFile, JSON.stringify(result, null, 2), "utf8");

    // Append to metric time series (JSONL for easy streaming/parsing)
    const ts = new Date().toISOString();

    if (result.pytorch?.loss != null) {
      appendFileSync(
        join(this.metricsDir, "pytorch-loss.jsonl"),
        JSON.stringify({ ts, iteration: result.iteration, loss: result.pytorch.loss }) + "\n"
      );
    }

    if (result.pytorch?.accuracy != null) {
      appendFileSync(
        join(this.metricsDir, "pytorch-accuracy.jsonl"),
        JSON.stringify({ ts, iteration: result.iteration, accuracy: result.pytorch.accuracy }) + "\n"
      );
    }

    if (result.resilience?.delta != null) {
      appendFileSync(
        join(this.metricsDir, "resilience-delta.jsonl"),
        JSON.stringify({ ts, iteration: result.iteration, delta: result.resilience.delta }) + "\n"
      );
    }

    appendFileSync(
      join(this.metricsDir, "task-throughput.jsonl"),
      JSON.stringify({
        ts,
        iteration: result.iteration,
        tasksCompleted: result.tasksCompleted,
        elapsedHours: result.elapsedHours,
      }) + "\n"
    );

    // Update daily summary
    this._updateDailySummary(date, result);
  }

  _updateDailySummary(date, latestResult) {
    const summaryFile = join(this._dailyDir(date), "summary.json");
    let summary = { date, iterations: 0, firstIteration: null, lastIteration: null, stats: {} };

    if (existsSync(summaryFile)) {
      try {
        summary = JSON.parse(readFileSync(summaryFile, "utf8"));
      } catch {
        // Reset
      }
    }

    summary.iterations += 1;
    summary.lastIteration = latestResult.iteration;
    if (!summary.firstIteration) summary.firstIteration = latestResult.iteration;
    summary.lastUpdated = new Date().toISOString();

    // Track best metrics for the day
    if (latestResult.pytorch?.accuracy != null) {
      if (!summary.stats.bestAccuracy || latestResult.pytorch.accuracy > summary.stats.bestAccuracy) {
        summary.stats.bestAccuracy = latestResult.pytorch.accuracy;
      }
    }
    if (latestResult.pytorch?.loss != null) {
      if (!summary.stats.bestLoss || latestResult.pytorch.loss < summary.stats.bestLoss) {
        summary.stats.bestLoss = latestResult.pytorch.loss;
      }
    }
    if (latestResult.resilience?.delta != null) {
      if (!summary.stats.bestResilienceDelta || latestResult.resilience.delta > summary.stats.bestResilienceDelta) {
        summary.stats.bestResilienceDelta = latestResult.resilience.delta;
      }
    }
    summary.stats.totalTasksCompleted = latestResult.tasksCompleted;
    summary.stats.totalElapsedHours = latestResult.elapsedHours;

    writeFileSync(summaryFile, JSON.stringify(summary, null, 2), "utf8");
  }

  /**
   * Write verified skill candidates for the day.
   */
  writeSkillCandidates(candidates) {
    const date = this._today();
    const dir = this._skillsDir(date);
    const file = join(dir, "candidates.json");

    let existing = [];
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        existing = [];
      }
    }

    existing.push({
      timestamp: new Date().toISOString(),
      ...candidates,
    });

    writeFileSync(file, JSON.stringify(existing, null, 2), "utf8");
  }

  /**
   * Write benchmark results for the day.
   */
  writeBenchmarkResult(result) {
    const date = this._today();
    const dir = this._benchmarksDir(date);
    const file = join(dir, "results.json");

    let existing = [];
    if (existsSync(file)) {
      try {
        existing = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        existing = [];
      }
    }

    existing.push({
      timestamp: new Date().toISOString(),
      ...result,
    });

    writeFileSync(file, JSON.stringify(existing, null, 2), "utf8");
  }

  /**
   * Update latest status snapshot (for dashboard GitHub fallback).
   */
  updateLatestStatus(status) {
    writeFileSync(join(this.latestDir, "status.json"), JSON.stringify(status, null, 2), "utf8");
  }

  /**
   * Update latest log tail (for dashboard GitHub fallback).
   */
  updateLatestLogTail(logFile, maxLines = 200) {
    if (!existsSync(logFile)) return;
    const text = readFileSync(logFile, "utf8");
    const lines = text.split("\n").filter((l) => l.trim().length > 0).slice(-maxLines);
    writeFileSync(join(this.latestDir, "recent.log"), lines.join("\n") + "\n", "utf8");
  }
}
