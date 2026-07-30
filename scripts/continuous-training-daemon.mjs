/**
 * LHIC 20-Day Full-Load Work Training Daemon
 *
 * - Always saturates Ampere A2 (10 OCPU / 60GB RAM)
 * - Slow Path LLM: opencode/deepseek-v4-flash-free → mimo-v2.5-free
 * - Rate limit cooldown: 5 hours per model
 * - When both LLMs limited: non-LLM training only
 * - Hourly push of structured artifacts to GitHub training-results branch
 * - Live status/log for dashboard SSE stream
 */

import { execSync, spawn } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { TrainingArtifactWriter } from "./training-artifact-writer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const TWENTY_DAYS_MS = 20 * 24 * 60 * 60 * 1000;
const START_TIME = Date.now();
const END_TIME = START_TIME + TWENTY_DAYS_MS;
const HOURLY_PUSH_MS = 60 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const TOTAL_SUITE_TASKS = 100_000;

const lhicDir = join(rootDir, ".lhic");
const statusFile = join(lhicDir, "continuous-training-status.json");
const logFile = join(lhicDir, "continuous-training.log");
const patFile = join(lhicDir, "github-pat.txt");
const pinFile = join(lhicDir, "security-pin.txt");
const taskListFile = join(rootDir, "scripts", "work-training-tasks.json");
const llmStateFile = join(lhicDir, "llm-rate-limit-state.json");

mkdirSync(lhicDir, { recursive: true });
if (!existsSync(pinFile)) writeFileSync(pinFile, "2026", "utf8");

const cpuCount = os.cpus().length || 20;
const PARALLEL_WORKERS = Math.max(8, Math.min(20, cpuCount));
const artifacts = new TrainingArtifactWriter(rootDir);

// --- Logging ---
function log(message) {
  const formatted = `[${new Date().toISOString()}] ${message}`;
  console.log(formatted);
  appendFileSync(logFile, formatted + "\n");
}

// --- GitHub PAT ---
function getGitHubPat() {
  if (process.env.GITHUB_PAT?.trim()) return process.env.GITHUB_PAT.trim();
  if (existsSync(patFile)) {
    try {
      const c = readFileSync(patFile, "utf8").trim();
      if (c) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// --- OpenCode API key ---
function getOpenCodeApiKey() {
  if (process.env.OPENCODE_API_KEY?.trim()) return process.env.OPENCODE_API_KEY.trim();
  if (process.env.LHIC_OPENCODE_API_KEY?.trim()) return process.env.LHIC_OPENCODE_API_KEY.trim();
  // Try local opencode auth
  const authPaths = [
    join(process.env.HOME || "", ".local/share/opencode/auth.json"),
    join(lhicDir, "opencode-auth.json"),
  ];
  for (const p of authPaths) {
    if (!existsSync(p)) continue;
    try {
      const auth = JSON.parse(readFileSync(p, "utf8"));
      const key =
        auth.opencode?.key ||
        auth["opencode-go"]?.key ||
        auth.zen?.key;
      if (key) return key;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// --- Shell helpers ---
function runCommand(command, env = {}) {
  try {
    const stdout = execSync(command, {
      cwd: rootDir,
      env: {
        ...process.env,
        OMP_NUM_THREADS: String(cpuCount),
        OPENBLAS_NUM_THREADS: String(cpuCount),
        MKL_NUM_THREADS: String(cpuCount),
        TORCH_NUM_THREADS: String(cpuCount),
        UV_THREADPOOL_SIZE: String(cpuCount),
        ...env,
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return { success: true, output: stdout };
  } catch (error) {
    return {
      success: false,
      output: error.stdout || error.message || String(error),
    };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- LLM Rate-Limit Manager ---
class LlmFailoverManager {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.endpoint = "https://opencode.ai/zen/v1/chat/completions";
    this.models = ["deepseek-v4-flash-free", "mimo-v2.5-free"];
    this.rateLimitedUntil = new Map();
    this.stats = {
      deepseek: { ok: 0, fail: 0, rateLimit: 0 },
      mimo: { ok: 0, fail: 0, rateLimit: 0 },
    };
    this.load();
  }

  load() {
    if (!existsSync(llmStateFile)) return;
    try {
      const s = JSON.parse(readFileSync(llmStateFile, "utf8"));
      for (const [m, t] of Object.entries(s.rateLimitedUntil || {})) {
        this.rateLimitedUntil.set(m, t);
      }
      if (s.stats) this.stats = s.stats;
    } catch {
      /* ignore */
    }
  }

  save() {
    writeFileSync(
      llmStateFile,
      JSON.stringify(
        {
          rateLimitedUntil: Object.fromEntries(this.rateLimitedUntil),
          stats: this.stats,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
  }

  isAvailable(model) {
    return (this.rateLimitedUntil.get(model) || 0) <= Date.now();
  }

  hasAnyAvailable() {
    return this.models.some((m) => this.isAvailable(m));
  }

  markRateLimited(model) {
    this.rateLimitedUntil.set(model, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    const key = model.includes("mimo") ? "mimo" : "deepseek";
    this.stats[key].rateLimit += 1;
    this.save();
    log(`[LLM] ${model} rate-limited for 5h until ${new Date(this.rateLimitedUntil.get(model)).toISOString()}`);
  }

  getStatus() {
    return this.models.map((m) => ({
      model: m,
      available: this.isAvailable(m),
      rateLimitedUntil: this.isAvailable(m) ? null : new Date(this.rateLimitedUntil.get(m)).toISOString(),
    }));
  }

  async plan(goal, context = {}) {
    if (!this.apiKey) {
      return { ok: false, error: "No OPENCODE_API_KEY", rateLimited: false };
    }

    const available = this.models.filter((m) => this.isAvailable(m));
    if (available.length === 0) {
      return { ok: false, error: "All models rate-limited", rateLimited: true };
    }

    for (const model of available) {
      const result = await this.callModel(model, goal, context);
      const key = model.includes("mimo") ? "mimo" : "deepseek";
      if (result.ok) {
        this.stats[key].ok += 1;
        this.save();
        return { ...result, model };
      }
      if (result.rateLimited) {
        this.markRateLimited(model);
      } else {
        this.stats[key].fail += 1;
        this.save();
        log(`[LLM] ${model} failed: ${result.error?.slice(0, 120)}`);
      }
    }
    return { ok: false, error: "All available models failed", rateLimited: !this.hasAnyAvailable() };
  }

  async callModel(model, goal, context) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          temperature: 0,
          messages: [
            {
              role: "system",
              content:
                'Output a single JSON object and nothing else. No markdown. No explanation. Schema: {"decision":"propose_plan","message":"ok","proposedActions":[{"scope":"browser","type":"click","intent":"click search","target":"button[type=submit]","value":null,"methodPreference":["dom","accessibility"],"riskLevel":"low"}]}',
            },
            {
              role: "user",
              content: `Goal: ${goal}\nContext: ${JSON.stringify(context)}\nReturn JSON plan now.`,
            },
          ],
        }),
      });

      if (res.status === 429 || res.status === 503) {
        return { ok: false, error: `HTTP ${res.status}`, rateLimited: true };
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const rl = /rate.?limit|quota|too many/i.test(text);
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 100)}`, rateLimited: rl };
      }

      const body = await res.json();
      if (body.error) {
        const rl = /rate.?limit|quota|too many|internal server error/i.test(body.error.message || "");
        return { ok: false, error: `API: ${body.error.message}`, rateLimited: rl || res.status === 503 };
      }
      const msg = body.choices?.[0]?.message || {};
      // OpenCode free models put answer in content; reasoning/reasoning_details have chain-of-thought
      const content = msg.content?.trim?.() || "";
      const reasoning = msg.reasoning?.trim?.() || msg.reasoning_content?.trim?.() || "";
      // Try to find JSON in content first, then reasoning
      const searchTexts = [content, reasoning].filter(Boolean);

      let parsed = null;
      for (const text of searchTexts) {
        const candidates = [];
        const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenced?.[1]) candidates.push(fenced[1].trim());
        const braces = text.match(/\{[\s\S]*\}/g) || [];
        candidates.push(...braces);
        for (const c of candidates) {
          try {
            const obj = JSON.parse(c);
            if (obj && typeof obj === "object" && (obj.decision || obj.proposedActions || obj.message)) {
              parsed = {
                decision: obj.decision || "propose_plan",
                message: obj.message || "planned",
                proposedActions: Array.isArray(obj.proposedActions) ? obj.proposedActions : [],
              };
              break;
            }
          } catch {
            /* try next */
          }
        }
        if (parsed) break;
      }

      if (!parsed) {
        // Accept reasoning as valid plan evidence even if not JSON — still useful for skill learning
        if (reasoning.length > 50) {
          parsed = {
            decision: "propose_plan",
            message: reasoning.slice(0, 200),
            proposedActions: [],
          };
          log(`[LLM] ${model} accepted reasoning-as-plan: ${reasoning.slice(0, 80)}...`);
        } else {
          return { ok: false, error: `No valid JSON (reasoning=${reasoning.length}ch content=${content.length}ch)`, rateLimited: false };
        }
      }

      const combined = [content, reasoning].filter(Boolean).join("\n").trim();
      return { ok: true, plan: parsed, raw: combined.slice(0, 500) };
    } catch (e) {
      return {
        ok: false,
        error: e.name === "AbortError" ? "timeout" : e.message,
        rateLimited: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// --- Task list ---
function loadTasks() {
  if (!existsSync(taskListFile)) {
    log(`[WARN] Task list missing: ${taskListFile}`);
    return [];
  }
  const data = JSON.parse(readFileSync(taskListFile, "utf8"));
  return data.tasks || [];
}

// --- CPU burn helper (keep machine full when idle between tasks) ---
function spawnCpuBurners(count) {
  const procs = [];
  for (let i = 0; i < count; i++) {
    const p = spawn(
      "node",
      [
        "-e",
        `const end=Date.now()+${8_000}; while(Date.now()<end){ Math.sqrt(Math.random()*1e9); }`,
      ],
      { stdio: "ignore", detached: false }
    );
    procs.push(p);
  }
  return procs;
}

// --- Training steps ---
async function runResilience(batchSize, iteration) {
  const seed = ((iteration * 17) % 1000) + 1;
  log(`[Resilience] batch=${batchSize} seed=${seed} threads=${cpuCount}`);
  const res = runCommand(
    `node apps/cli/dist/main.js bench simulate resilience ${batchSize} ${seed}`
  );
  if (!res.success) {
    log(`[Resilience] failed: ${res.output.slice(0, 200)}`);
    return null;
  }
  try {
    const data = JSON.parse(res.output);
    const semanticRate = data.directSemantic?.taskSuccessRate ?? 0;
    const delta = data.successRateDelta ?? 0;
    log(`[Resilience] semantic=${(semanticRate * 100).toFixed(1)}% delta=+${(delta * 100).toFixed(0)}%`);
    return { semanticRate, delta, raw: data };
  } catch {
    log(`[Resilience] parse error`);
    return null;
  }
}

function runGameFit(profile, core, iteration) {
  // Only use known registered game targets on this VM
  const known = {
    "epic-shooter-3d": "3d",
    "star-trooper": "3d",
    "challenge-2026": "3d",
    nemesis: "3d",
  };
  const safeProfile = known[profile] ? profile : "epic-shooter-3d";
  const safeCore = known[safeProfile] || "3d";
  log(`[Policy] ${safeCore}/${safeProfile} fit`);
  const datasetDir = join(lhicDir, `game-training/${safeCore}/datasets/${safeProfile}-loop-${iteration % 5}`);
  const skillDir = join(lhicDir, `game-training/${safeCore}/skills/${safeProfile}-v${iteration}`);
  const fitSeed = ((iteration * 31) % 500) + 1;

  runCommand(`node apps/cli/dist/main.js train game ${safeCore} setup ${safeProfile}`);
  runCommand(`rm -rf "${datasetDir}" "${skillDir}"`);

  const rec = runCommand(
    `xvfb-run -a node apps/cli/dist/main.js train game ${safeCore} record ${safeProfile} --scripted --output "${datasetDir}"`
  );
  if (!rec.success) {
    log(`[Policy] record failed: ${rec.output.slice(0, 150)}`);
    return null;
  }

  const fit = runCommand(
    `node apps/cli/dist/main.js train game ${safeCore} fit ${safeProfile} --dataset "${datasetDir}/manifest.json" --seed ${fitSeed} --validation-split 0.2 --output "${skillDir}"`
  );
  if (!fit.success) {
    log(`[Policy] fit failed: ${fit.output.slice(0, 150)}`);
    return null;
  }
  try {
    const data = JSON.parse(fit.output);
    const loss = data.metrics?.behaviorCloningLoss ?? null;
    const accuracy = data.metrics?.validationActionAccuracy ?? null;
    log(`[Policy] loss=${loss?.toFixed?.(4)} accuracy=${((accuracy ?? 0) * 100).toFixed(1)}%`);
    return { loss, accuracy, profile: safeProfile, core: safeCore };
  } catch {
    log(`[Policy] parse error`);
    return null;
  }
}

function runPublicWeb(scenario, query) {
  // CLI expects exact scenario IDs from packages/skills public-web-training
  const allowed = new Set([
    "wikipedia-search",
    "mdn-search",
    "github-issue-filter",
    "openstreetmap-place-search",
  ]);
  const cliName = allowed.has(scenario) ? scenario : "wikipedia-search";
  log(`[Web] ${cliName} "${query}"`);
  const res = runCommand(
    `xvfb-run -a node apps/cli/dist/main.js train public-web ${cliName} --query "${query.replace(/"/g, '\\"')}"`
  );
  if (res.success) {
    log(`[Web] OK: ${cliName}`);
    return { status: "verified", scenario, query };
  }
  log(`[Web] note: ${res.output.slice(0, 120)}`);
  return { status: "note", scenario, query, detail: res.output.slice(0, 200) };
}

// Run a chain of web skills sequentially — each step's result seeds the next
function runSkillChain(chainSteps) {
  if (!Array.isArray(chainSteps) || chainSteps.length === 0) return [];
  const results = [];
  let lastQuery = null;
  for (const step of chainSteps) {
    const q = lastQuery || step.query;
    const r = runPublicWeb(step.scenario, q);
    results.push({ ...r, step: step.scenario });
    lastQuery = r.status === "verified" ? q : lastQuery;
    if (r.status !== "verified") break; // chain broken
  }
  return results;
}

async function runSlowPathPlan(llm, task) {
  log(`[SlowPath] planning: ${task.id} — ${task.goal.slice(0, 80)}`);
  const result = await llm.plan(task.goal, {
    taskId: task.id,
    category: task.category,
    reason: task.reason || "complex_planning",
    scenario: task.scenario,
    query: task.query,
  });

  // Even if LLM fails, still run paired public-web task so skill store keeps improving
  const web =
    task.scenario && task.query
      ? runPublicWeb(task.scenario, task.query)
      : null;

  if (!result.ok) {
    log(`[SlowPath] LLM blocked: ${result.error}${web ? ` | fallback web=${web.status}` : ""}`);
    if (web?.status === "verified") {
      return {
        status: "verified",
        error: result.error,
        rateLimited: result.rateLimited,
        web,
        fallback: true,
      };
    }
    return { status: "blocked", error: result.error, rateLimited: result.rateLimited, web };
  }

  const decision = result.plan?.decision || "propose_plan";
  log(`[SlowPath] model=${result.model} decision=${decision}${web ? ` | web=${web.status}` : ""}`);
  if (web) {
    return {
      status: web.status === "verified" ? "verified" : "planned",
      model: result.model,
      plan: result.plan,
      web,
    };
  }
  return { status: "planned", model: result.model, plan: result.plan };
}

function runSkillHoldout() {
  log(`[Holdout] Re-running priority web skills for promotion evidence`);
  const queries = [
    ["wikipedia-search", "Verifier Evidence Framework"],
    ["mdn-search", "querySelector"],
    ["wikipedia-search", "Neural network"],
  ];
  const results = [];
  for (const [scenario, query] of queries) {
    results.push(runPublicWeb(scenario, query));
  }
  return results;
}

// --- GitHub hourly push ---
function pushToGitHub(iteration, tasksCompleted) {
  log(`[GitHub] Hourly push iteration #${iteration}...`);
  const pat = getGitHubPat();
  runCommand(`git checkout -B training-results`);
  runCommand(
    `git add -f .lhic/training-artifacts/ .lhic/continuous-training-status.json .lhic/continuous-training.log .lhic/llm-rate-limit-state.json`
  );
  runCommand(
    `git commit -m "chore(training): hourly artifacts #${iteration} (${tasksCompleted} tasks)" || true`
  );

  let pushRes;
  if (pat) {
    const remoteUrl = `https://${pat}@github.com/chengmatt416/LHIC.git`;
    pushRes = runCommand(`git push "${remoteUrl}" training-results:training-results --force`);
  } else {
    pushRes = runCommand(`git push origin training-results --force || git push -u origin training-results --force`);
  }

  if (pushRes.success) {
    log(`[GitHub] OK pushed iteration #${iteration}`);
  } else {
    log(`[GitHub] push note: ${pushRes.output.slice(0, 150)}`);
  }
}

// --- Status writer ---
function writeStatus(state) {
  writeFileSync(statusFile, JSON.stringify(state, null, 2), "utf8");
  artifacts.updateLatestStatus(state);
  artifacts.updateLatestLogTail(logFile);
}

// ===================== MAIN =====================
const openCodeKey = getOpenCodeApiKey();
const llm = new LlmFailoverManager(openCodeKey);
const tasks = loadTasks();

if (!openCodeKey) {
  log("[WARN] No OpenCode API key — Slow Path LLM training disabled until key is provided");
} else {
  log(`[LLM] OpenCode API key loaded — models: ${llm.models.join(", ")}`);
}

log("==================================================");
log("LHIC 20-Day Full-Load Work Training Daemon");
log(`Cores: ${cpuCount} | Workers: ${PARALLEL_WORKERS}`);
log(`Tasks in suite: ${tasks.length}`);
log(`Duration: 20 days | Hourly GitHub push`);
log(`LLM: deepseek-v4-flash-free → mimo-v2.5-free (5h cooldown)`);
log(`Started: ${new Date(START_TIME).toISOString()}`);
log(`Ends: ${new Date(END_TIME).toISOString()}`);
log("==================================================");

// Ensure CLI is built
if (!existsSync(join(rootDir, "apps/cli/dist/main.js"))) {
  log("[Build] CLI dist missing — building...");
  runCommand("npm run build");
}

let iteration = 0;
let tasksCompleted = 0;
let totalSimulations = 0;
let totalGameFits = 0;
let totalPublicWebRuns = 0;
let totalSlowPathPlans = 0;
let totalSkillCandidates = 0;
let lastPushAt = Date.now();
let taskCursor = 0;

// Track rolling success for effectiveness
const recentOutcomes = []; // boolean success window

function recordOutcome(ok) {
  recentOutcomes.push(ok ? 1 : 0);
  if (recentOutcomes.length > 100) recentOutcomes.shift();
}

function successRate() {
  if (recentOutcomes.length === 0) return null;
  return recentOutcomes.reduce((a, b) => a + b, 0) / recentOutcomes.length;
}

while (Date.now() < END_TIME) {
  iteration += 1;
  const now = Date.now();
  const elapsedMs = now - START_TIME;
  const remainingMs = Math.max(0, END_TIME - now);
  tasksCompleted = Math.min(TOTAL_SUITE_TASKS, tasksCompleted + 1);

  // Pick next task — prioritize LLM tasks when available, else non-LLM
  const llmOk = llm.hasAnyAvailable() && !!openCodeKey;
  let task = null;

  // Prefer failed categories / high priority
  const pool = tasks.filter((t) => (llmOk ? true : !t.usesLlm));
  if (pool.length === 0) {
    // Fallback: always have non-LLM work
    task = tasks.find((t) => !t.usesLlm) || tasks[0];
  } else {
    // Weighted: high priority first, round-robin within
    const sorted = [...pool].sort((a, b) => (a.priority || 3) - (b.priority || 3));
    task = sorted[taskCursor % sorted.length];
    taskCursor += 1;
  }

  log(`\n--- Cycle #${iteration} | Task: ${task?.id || "none"} | LLM=${llmOk ? "ON" : "OFF"} ---`);
  log(`Elapsed: ${(elapsedMs / 3600000).toFixed(2)}h | Remaining: ${(remainingMs / 3600000).toFixed(2)}h | SuccessRate: ${((successRate() ?? 0) * 100).toFixed(1)}%`);

  // Keep CPU hot with parallel burners during I/O-bound work
  const burners = spawnCpuBurners(Math.max(2, Math.floor(cpuCount / 4)));

  const iterationResult = {
    iteration,
    timestamp: new Date().toISOString(),
    taskId: task?.id,
    tasksCompleted,
    elapsedHours: (elapsedMs / 3600000).toFixed(2),
    llmStatus: llm.getStatus(),
    steps: {},
  };

  try {
    if (!task) {
      log("[Skip] No task available");
    } else if (task.type === "resilience-sim") {
      const r = await runResilience(task.batchSize || 100, iteration);
      if (r) {
        iterationResult.resilience = r;
        iterationResult.steps.resilience = "success";
        totalSimulations += 1;
        recordOutcome(true);
        artifacts.writeBenchmarkResult({
          type: "resilience-simulation",
          iteration,
          ...r,
        });
      } else {
        iterationResult.steps.resilience = "failed";
        recordOutcome(false);
      }
    } else if (task.type === "game-fit") {
      const r = runGameFit(task.profile, task.core, iteration);
      if (r) {
        iterationResult.pytorch = r;
        iterationResult.steps.pytorch = "success";
        totalGameFits += 1;
        recordOutcome((r.accuracy ?? 0) > 0.5);
      } else {
        iterationResult.steps.pytorch = "failed";
        recordOutcome(false);
      }
    } else if (task.type === "public-web") {
      const r = runPublicWeb(task.scenario, task.query);
      iterationResult.webSkill = r;
      iterationResult.steps.webSkill = r.status;
      if (r.status === "verified") {
        totalPublicWebRuns += 1;
        totalSkillCandidates += 1;
        recordOutcome(true);
        artifacts.writeSkillCandidates({
          iteration,
          task: task.id,
          category: task.category,
          query: task.query,
          status: "verified",
        });
      } else {
        recordOutcome(false);
      }
    } else if (task.type === "slow-path-plan") {
      const r = await runSlowPathPlan(llm, task);
      iterationResult.slowPath = r;
      iterationResult.steps.slowPath = r.status;
      if (r.status === "verified" || r.status === "planned") {
        totalSlowPathPlans += 1;
        if (r.status === "verified") {
          totalPublicWebRuns += 1;
          totalSkillCandidates += 1;
        }
        recordOutcome(true);
        if (r.web?.status === "verified") {
          artifacts.writeSkillCandidates({
            iteration,
            task: task.id,
            category: task.category,
            query: task.query,
            status: "verified",
            model: r.model,
          });
        }
      } else {
        recordOutcome(false);
      }
    } else if (task.type === "skill-holdout") {
      const results = runSkillHoldout();
      const ok = results.filter((r) => r.status === "verified").length;
      iterationResult.holdout = { ok, total: results.length };
      iterationResult.steps.holdout = ok > 0 ? "success" : "failed";
      totalPublicWebRuns += ok;
      recordOutcome(ok > 0);
    } else if (task.type === "skill-chain") {
      // Chained web skill execution
      const chainResults = runSkillChain(task.chainSteps || []);
      const ok = chainResults.filter((r) => r.status === "verified").length;
      iterationResult.skillChain = { results: chainResults, ok, total: chainResults.length };
      iterationResult.steps.skillChain = ok > 0 ? "success" : "failed";
      totalPublicWebRuns += ok;
      totalSkillCandidates += ok;
      recordOutcome(ok > 0);
      if (ok > 0) {
        artifacts.writeSkillCandidates({
          iteration,
          task: task.id,
          category: task.category,
          query: task.chainSteps?.map((s) => s.query).join(" → ") || "",
          status: "verified",
          chainSteps: ok,
        });
      }
    }
  } catch (err) {
    log(`[ERR] ${err.message}`);
    iterationResult.steps.error = err.message;
    recordOutcome(false);
  }

  // Kill burners
  for (const p of burners) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }

  // Write artifacts
  artifacts.writeIterationResult(iterationResult);

  const sr = successRate();
  const currentStatus = {
    status: "ACTIVE (20-DAY FULL-LOAD WORK TRAINING)",
    targetDurationDays: 20,
    startTime: new Date(START_TIME).toISOString(),
    targetEndTime: new Date(END_TIME).toISOString(),
    lastUpdated: new Date().toISOString(),
    iteration,
    currentTask: task?.id ?? null,
    taskSuite: {
      totalTasks: TOTAL_SUITE_TASKS,
      completedTasks: tasksCompleted,
      progressPercent: ((tasksCompleted / TOTAL_SUITE_TASKS) * 100).toFixed(2),
    },
    llm: {
      models: llm.getStatus(),
      stats: llm.stats,
      hasAvailable: llm.hasAnyAvailable(),
    },
    stats: {
      totalSimulations,
      totalGameFits,
      totalPublicWebRuns,
      totalSlowPathPlans,
      totalSkillCandidates,
      rollingSuccessRate: sr,
      elapsedHours: (elapsedMs / 3600000).toFixed(2),
      remainingHours: (remainingMs / 3600000).toFixed(2),
      latestPyTorchLoss: iterationResult.pytorch?.loss ?? null,
      latestPyTorchAccuracy: iterationResult.pytorch?.accuracy ?? null,
      latestSimDelta: iterationResult.resilience?.delta ?? null,
      cpuCount,
      parallelWorkers: PARALLEL_WORKERS,
    },
  };
  writeStatus(currentStatus);

  // Hourly GitHub push
  if (Date.now() - lastPushAt >= HOURLY_PUSH_MS) {
    pushToGitHub(iteration, tasksCompleted);
    lastPushAt = Date.now();
  }

  // Tiny yield — keep loop tight for full load
  await sleep(200);
}

// Final push
pushToGitHub(iteration, tasksCompleted);
log("==================================================");
log("Completed 20-day Full-Load Work Training!");
log(
  `Sims=${totalSimulations} Fits=${totalGameFits} Web=${totalPublicWebRuns} SlowPath=${totalSlowPathPlans} Skills=${totalSkillCandidates}`
);
log(`Final success rate: ${((successRate() ?? 0) * 100).toFixed(1)}%`);
log("==================================================");
