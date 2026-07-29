import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Monthly Training Aggregation Script
 *
 * Reads structured training artifacts and generates optimization-ready reports.
 *
 * Usage: node scripts/aggregate-training-report.mjs [--month YYYY-MM]
 * Output: .lhic/training-artifacts/reports/YYYY-MM.json
 */

const rootDir = process.cwd();
const artifactsDir = join(rootDir, ".lhic", "training-artifacts");
const reportsDir = join(artifactsDir, "reports");

const monthArg = process.argv.find((a) => a.startsWith("--month="));
const targetMonth = monthArg
  ? monthArg.split("=")[1]
  : new Date().toISOString().slice(0, 7);

mkdirSync(reportsDir, { recursive: true });

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const text = readFileSync(filePath, "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .filter((entry) => entry.ts?.startsWith(targetMonth));
}

function readDailySummaries() {
  const dailyDir = join(artifactsDir, "daily");
  if (!existsSync(dailyDir)) return [];
  const summaries = [];
  const dates = readdirSync(dailyDir).filter((d) => d.startsWith(targetMonth));
  for (const date of dates) {
    const summaryFile = join(dailyDir, date, "summary.json");
    if (existsSync(summaryFile)) {
      try { summaries.push(JSON.parse(readFileSync(summaryFile, "utf8"))); } catch { /* skip corrupted */ }
    }
  }
  return summaries.sort((a, b) => a.date.localeCompare(b.date));
}

function readSkillCandidates() {
  const skillsDir = join(artifactsDir, "skills");
  if (!existsSync(skillsDir)) return [];
  const candidates = [];
  const dates = readdirSync(skillsDir).filter((d) => d.startsWith(targetMonth));
  for (const date of dates) {
    const file = join(skillsDir, date, "candidates.json");
    if (existsSync(file)) {
      try { candidates.push(...JSON.parse(readFileSync(file, "utf8"))); } catch { /* skip corrupted */ }
    }
  }
  return candidates;
}

function readBenchmarkResults() {
  const benchDir = join(artifactsDir, "benchmarks");
  if (!existsSync(benchDir)) return [];
  const results = [];
  const dates = readdirSync(benchDir).filter((d) => d.startsWith(targetMonth));
  for (const date of dates) {
    const file = join(benchDir, date, "results.json");
    if (existsSync(file)) {
      try { results.push(...JSON.parse(readFileSync(file, "utf8"))); } catch { /* skip corrupted */ }
    }
  }
  return results;
}

function computeStats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return {
    count: values.length, min: sorted[0], max: sorted[sorted.length - 1],
    mean, median: sorted[Math.floor(sorted.length / 2)], stddev: Math.sqrt(variance),
    p95: sorted[Math.floor(sorted.length * 0.95)], p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

function trendDirection(values) {
  if (values.length < 5) return "insufficient-data";
  const recent = values.slice(-10);
  const earlier = values.slice(0, 10);
  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierMean = earlier.reduce((a, b) => a + b, 0) / earlier.length;
  const change = (recentMean - earlierMean) / Math.abs(earlierMean || 1);
  if (change > 0.05) return "improving";
  if (change < -0.05) return "degrading";
  return "stable";
}

console.log(`Generating training report for ${targetMonth}...`);

const lossData = readJsonl(join(artifactsDir, "metrics", "pytorch-loss.jsonl"));
const accuracyData = readJsonl(join(artifactsDir, "metrics", "pytorch-accuracy.jsonl"));
const resilienceData = readJsonl(join(artifactsDir, "metrics", "resilience-delta.jsonl"));
const throughputData = readJsonl(join(artifactsDir, "metrics", "task-throughput.jsonl"));
const dailySummaries = readDailySummaries();
const skillCandidates = readSkillCandidates();
const benchmarkResults = readBenchmarkResults();

const lossValues = lossData.map((d) => d.loss).filter((v) => v != null);
const accuracyValues = accuracyData.map((d) => d.accuracy).filter((v) => v != null);
const deltaValues = resilienceData.map((d) => d.delta).filter((v) => v != null);

const report = {
  month: targetMonth,
  generatedAt: new Date().toISOString(),
  overview: {
    totalDays: dailySummaries.length,
    totalIterations: dailySummaries.reduce((acc, d) => acc + (d.iterations || 0), 0),
    totalTasksCompleted: throughputData.length > 0 ? throughputData[throughputData.length - 1].tasksCompleted : 0,
    totalElapsedHours: throughputData.length > 0 ? throughputData[throughputData.length - 1].elapsedHours : "0",
    totalSkillCandidates: skillCandidates.length,
    totalBenchmarks: benchmarkResults.length,
  },
  metrics: {
    pytorchLoss: { stats: computeStats(lossValues), trend: trendDirection(lossValues), timeSeries: lossData.map((d) => ({ ts: d.ts, iteration: d.iteration, value: d.loss })) },
    pytorchAccuracy: { stats: computeStats(accuracyValues), trend: trendDirection(accuracyValues), timeSeries: accuracyData.map((d) => ({ ts: d.ts, iteration: d.iteration, value: d.accuracy })) },
    resilienceDelta: { stats: computeStats(deltaValues), trend: trendDirection(deltaValues), timeSeries: resilienceData.map((d) => ({ ts: d.ts, iteration: d.iteration, value: d.delta })) },
    throughput: { dailyIterations: dailySummaries.map((d) => ({ date: d.date, iterations: d.iterations })) },
  },
  dailySummaries,
  skillCatalog: {
    total: skillCandidates.length,
    byCategory: skillCandidates.reduce((acc, c) => {
      const cat = c.category || "unknown";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push({ iteration: c.iteration, type: c.type, query: c.query, status: c.status });
      return acc;
    }, {}),
  },
  benchmarkSummary: {
    total: benchmarkResults.length,
    results: benchmarkResults.map((b) => ({ timestamp: b.timestamp, type: b.type, iteration: b.iteration, semanticRate: b.semanticRate, delta: b.delta })),
  },
  optimizationRecommendations: [],
};

if (lossValues.length > 0) {
  const latestLoss = lossValues[lossValues.length - 1];
  if (latestLoss > 2.0) {
    report.optimizationRecommendations.push({ priority: "high", area: "pytorch-training", message: `Loss is still high (${latestLoss.toFixed(4)}). Consider increasing dataset size or adjusting learning rate.` });
  }
}

if (accuracyValues.length > 0) {
  const latestAcc = accuracyValues[accuracyValues.length - 1];
  if (latestAcc < 0.7) {
    report.optimizationRecommendations.push({ priority: "high", area: "pytorch-training", message: `Validation accuracy is low (${(latestAcc * 100).toFixed(1)}%). Consider more training data or model capacity tuning.` });
  } else if (latestAcc > 0.9) {
    report.optimizationRecommendations.push({ priority: "low", area: "pytorch-training", message: `Validation accuracy is excellent (${(latestAcc * 100).toFixed(1)}%). Consider testing on harder tasks.` });
  }
}

const skillCategories = Object.keys(report.skillCatalog.byCategory);
const missingCategories = ["search", "docs", "project", "geo", "commerce", "interaction", "navigation", "dynamic"].filter((c) => !skillCategories.includes(c));
if (missingCategories.length > 0) {
  report.optimizationRecommendations.push({ priority: "medium", area: "skill-coverage", message: `Missing skill categories: ${missingCategories.join(", ")}. Expand training task variety.` });
}

const reportFile = join(reportsDir, `${targetMonth}.json`);
writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
console.log(`Report written to: ${reportFile}`);

console.log(`\n=== ${targetMonth} Training Report ===`);
console.log(`Days active: ${report.overview.totalDays}`);
console.log(`Total iterations: ${report.overview.totalIterations}`);
console.log(`Loss: ${report.metrics.pytorchLoss.stats?.mean?.toFixed(4) ?? "N/A"} (trend: ${report.metrics.pytorchLoss.trend})`);
console.log(`Accuracy: ${(report.metrics.pytorchAccuracy.stats?.mean * 100)?.toFixed(1) ?? "N/A"}% (trend: ${report.metrics.pytorchAccuracy.trend})`);
console.log(`Resilience delta: ${(report.metrics.resilienceDelta.stats?.mean * 100)?.toFixed(0) ?? "N/A"}% (trend: ${report.metrics.resilienceDelta.trend})`);
console.log(`Skill candidates: ${report.overview.totalSkillCandidates} across ${skillCategories.length} categories`);
console.log(`Recommendations: ${report.optimizationRecommendations.length}`);
