#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyTask } from "./verifier.mjs";

const benchmarkRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(benchmarkRoot, "../..");
const categories = ["coding", "browser", "desktop"];
const args = parseArguments(process.argv.slice(2));
if (args.selfTest) {
  await selfTest();
  process.exit(0);
}
const product = args.product;
const track = args.track;
const repetitions = args.repetitions;
const artifactRoot = resolve(
  args.output ?? join(benchmarkRoot, "artifacts", `${product}-${Date.now()}`),
);
await mkdir(artifactRoot, { recursive: true });
const manifests = await Promise.all(categories.map(loadManifest));
const fixtureSetSha256 = sha256(
  manifests.map((entry) => entry.bytes).join("\n"),
);
const modelId = process.env.LHIC_BENCH_MODEL_ID ?? "unconfigured-model";
if (modelId !== "unconfigured-model" && !/^[^/]+\/[^/].*$/.test(modelId)) {
  throw new Error("LHIC_BENCH_MODEL_ID must be provider/exact-model-id.");
}
const command = await resolveProductCommand(product, modelId);
const runs = [];

for (const manifest of manifests) {
  for (const task of manifest.value.tasks) {
    if (args.task && task.id !== args.task) continue;
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      runs.push(
        await runTask({
          manifest,
          task,
          repetition,
          product,
          track,
          command,
          modelId,
          artifactRoot,
        }),
      );
    }
  }
}

let lhicCommit = "unknown";
try {
  lhicCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
} catch {
  // Evidence still records that the commit is unknown; it never fabricates one.
}

const evidence = {
  schemaVersion: "lhic-agent-competitive-v1",
  generatedAt: new Date().toISOString(),
  fixtureSetSha256,
  environment: {
    lhicCommit,
    os: process.platform,
    arch: process.arch,
    runtime: process.version,
  },
  runs,
};
const evidencePath = join(artifactRoot, "evidence.json");
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
  JSON.stringify({
    evidencePath,
    runs: runs.length,
    passed: runs.filter((run) => run.status === "passed").length,
  }),
);

async function runTask(options) {
  const {
    manifest,
    task,
    repetition,
    product,
    track,
    command,
    modelId,
    artifactRoot,
  } = options;
  const runName = `${task.id}-${repetition + 1}`;
  const runRoot = join(artifactRoot, runName);
  const workspace = join(runRoot, "workspace");
  const statePath = join(runRoot, "fixture-state.json");
  await mkdir(workspace, { recursive: true });
  for (const [relativePath, content] of Object.entries(task.files ?? {})) {
    const target = resolve(workspace, relativePath);
    if (!target.startsWith(`${workspace}/`))
      throw new Error(`Fixture path escapes workspace: ${relativePath}`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const fixtureSha256 = sha256(JSON.stringify(task));
  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  let exitCode = null;
  let timedOut = false;
  let fixtureProcess;
  let fixtureUrl;
  let injectedCrashes = 0;
  try {
    if (manifest.value.category === "browser") {
      fixtureProcess = await startFixture(
        process.execPath,
        [
          join(benchmarkRoot, "browser", "fixture-server.mjs"),
          manifest.path,
          task.id,
          statePath,
        ],
        repositoryRoot,
      );
      fixtureUrl = fixtureProcess.ready.url;
    } else if (manifest.value.category === "desktop") {
      fixtureProcess = await startFixture(
        resolveElectron(),
        [
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          join(benchmarkRoot, "desktop", "helper.mjs"),
          manifest.path,
          task.id,
          statePath,
        ],
        repositoryRoot,
      );
    }

    if (!command.available || modelId === "unconfigured-model") {
      stderr = !command.available
        ? command.reason
        : "LHIC_BENCH_MODEL_ID is not configured; comparable run not attempted.";
    } else {
      const prompt = taskPrompt(
        task,
        manifest.value.category,
        workspace,
        fixtureUrl,
      );
      const invocation = command.invocation(prompt);
      const execution = spawnCapture(invocation.file, invocation.args, {
        cwd: workspace,
        env: { ...process.env, ...invocation.env },
        timeoutMs: args.timeoutMs,
      });
      if (task.variation === "engine-crash" && product === "lhic") {
        void injectEngineCrash(execution.child, statePath).then((injected) => {
          if (injected) injectedCrashes += 1;
        });
      }
      const completed = await execution.result;
      stdout = completed.stdout;
      stderr = completed.stderr;
      exitCode = completed.exitCode;
      timedOut = completed.timedOut;
    }
  } finally {
    await stopFixture(fixtureProcess?.child);
  }

  const verification = await verifyTask({
    category: manifest.value.category,
    task,
    workspace,
    statePath,
  });
  const telemetry = telemetryFrom(stdout, stderr);
  const status =
    !command.available || modelId === "unconfigured-model"
      ? "not-run"
      : timedOut
        ? "timeout"
        : verification.passed
          ? "passed"
          : exitCode === null || exitCode === 0
            ? "failed"
            : "crashed";
  await writeFile(join(runRoot, "stdout.log"), stdout);
  await writeFile(join(runRoot, "stderr.log"), stderr);
  const artifactSha256 = sha256(
    `${stdout}\n${stderr}\n${JSON.stringify(verification)}`,
  );
  const result = {
    taskId: task.id,
    category: manifest.value.category,
    repetition,
    seed: task.seed + repetition,
    product,
    track,
    status,
    modelId,
    binaryVersion: command.version,
    binarySha256: command.sha256,
    fixtureSha256,
    artifactSha256,
    wallTimeMs: Math.round(performance.now() - startedAt),
    turns: telemetry.turns,
    approvals: telemetry.approvals,
    retries: telemetry.retries + injectedCrashes,
    duplicateVerifiedActions: await duplicateActions(statePath),
    verifierPassed: verification.passed,
  };
  await writeFile(
    join(runRoot, "result.json"),
    `${JSON.stringify({ ...result, verification }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      task: task.id,
      repetition,
      status,
      verification: verification.detail,
    }),
  );
  return result;
}

async function loadManifest(category) {
  const path = join(benchmarkRoot, category, "fixtures.json");
  const bytes = await readFile(path, "utf8");
  const value = JSON.parse(bytes);
  if (
    value.schemaVersion !== "lhic-competitive-fixtures-v1" ||
    value.category !== category ||
    value.tasks.length !== 4
  ) {
    throw new Error(`Invalid ${category} fixture manifest.`);
  }
  return { path, bytes, value };
}

async function resolveProductCommand(product, modelId) {
  if (product === "lhic") {
    const binary = join(
      repositoryRoot,
      "apps",
      "desktop",
      "vendor",
      "omp",
      "current",
      process.platform === "win32" ? "omp.exe" : "omp",
    );
    const available = await exists(binary);
    return {
      available,
      reason: available ? "" : `Bundled omp is missing: ${binary}`,
      version: "0.2.0+omp-17.2.15",
      sha256: available ? await hashFile(binary) : "0".repeat(64),
      invocation: (prompt) => ({
        file: process.execPath,
        args: [
          join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
          join(repositoryRoot, "apps", "cli", "src", "main.ts"),
          "agent",
          "--prompt",
          prompt,
          "--jsonl",
          "--approval-policy",
          "auto",
          "--approved-by",
          "competitive-benchmark",
          "--model",
          modelId,
        ],
        env: { OMP_BINARY: binary },
      }),
    };
  }

  const expectedVersion = product === "goose" ? "1.46.0" : "0.147.0";
  const overrideName = `LHIC_BENCH_${product.toUpperCase()}_COMMAND_JSON`;
  const override = process.env[overrideName];
  let executable;
  let baseArgs;
  let environment = {};
  if (override) {
    const command = JSON.parse(override);
    if (
      !Array.isArray(command) ||
      command.some((part) => typeof part !== "string") ||
      command.length === 0
    ) {
      throw new Error(`${overrideName} must be a JSON string array.`);
    }
    executable = await findExecutable(command[0]);
    baseArgs = command.slice(1);
  } else {
    executable = await findExecutable(product);
    const [provider, ...modelParts] = modelId.split("/");
    const model = modelParts.join("/");
    if (product === "goose") {
      baseArgs = ["run", "--text"];
      environment = { GOOSE_PROVIDER: provider, GOOSE_MODEL: model };
    } else {
      baseArgs = [
        "exec",
        "--model",
        model,
        "-c",
        `model_provider="${provider}"`,
        "--full-auto",
      ];
    }
  }
  if (!executable) {
    return unavailable(
      `${product} ${expectedVersion} is not installed.`,
      expectedVersion,
    );
  }
  const versionResult = await spawnCapture(executable, ["--version"], {
    cwd: repositoryRoot,
    env: process.env,
    timeoutMs: 10_000,
  }).result;
  if (
    !`${versionResult.stdout}\n${versionResult.stderr}`.includes(
      expectedVersion,
    )
  ) {
    return unavailable(
      `${product} version must contain ${expectedVersion}.`,
      expectedVersion,
    );
  }
  return productCommand(
    executable,
    baseArgs,
    expectedVersion,
    modelId,
    environment,
  );
}

async function productCommand(
  executable,
  baseArgs,
  version,
  modelId,
  environment,
) {
  if (!executable)
    return unavailable("Configured executable is not on PATH.", version);
  return {
    available: true,
    reason: "",
    version,
    sha256: await hashFile(executable),
    invocation: (prompt) => ({
      file: executable,
      args: [...baseArgs, prompt],
      env: { ...environment, LHIC_BENCH_MODEL_ID: modelId },
    }),
  };
}

function unavailable(reason, version) {
  return {
    available: false,
    reason,
    version,
    sha256: "0".repeat(64),
    invocation: () => ({ file: "", args: [], env: {} }),
  };
}

function taskPrompt(task, category, workspace, fixtureUrl) {
  const target =
    category === "coding"
      ? `Work only in ${workspace}.`
      : category === "browser"
        ? `Use browser controls on ${fixtureUrl}.`
        : "Use desktop controls on the visible LHIC Benchmark application.";
  return `${task.prompt}\n${target}\nComplete the task end to end, then stop. Do not modify benchmark manifests, verifier code, or fixture state files directly.`;
}

function spawnCapture(file, commandArgs, options) {
  const child = spawn(file, commandArgs, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, options.timeoutMs);
  const result = new Promise((resolveResult) => {
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolveResult({ stdout, stderr, exitCode, timedOut });
    });
  });
  return { child, result };
}

async function startFixture(file, commandArgs, cwd) {
  const execution = spawnCapture(file, commandArgs, {
    cwd,
    env: process.env,
    timeoutMs: args.timeoutMs + 30_000,
  });
  const ready = await new Promise((resolveReady, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("Fixture did not become ready.")),
      20_000,
    );
    execution.child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (const line of buffer.split("\n")) {
        try {
          const frame = JSON.parse(line);
          if (frame.type === "ready") {
            clearTimeout(timer);
            resolveReady(frame);
            return;
          }
        } catch {
          /* partial or diagnostic line */
        }
      }
    });
    execution.child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Fixture exited before readiness (${code}).`));
    });
  });
  return { child: execution.child, ready };
}

async function stopFixture(child) {
  if (!child || child.exitCode !== null) return;
  terminate(child);
  await new Promise((resolveDone) => child.once("close", resolveDone));
}

function terminate(child) {
  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGKILL");
  }
}

async function injectEngineCrash(child, statePath) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (state.prepared === true) {
        const ps = await spawnCapture("ps", ["-eo", "pid=,ppid=,comm="], {
          cwd: repositoryRoot,
          env: process.env,
          timeoutMs: 5_000,
        }).result;
        const rows = ps.stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/, 3));
        const descendants = descendantPids(rows, child.pid);
        const omp = rows.find(
          ([pid, , command]) =>
            descendants.has(Number(pid)) &&
            (command === "omp" || command === "omp.exe"),
        );
        if (omp) {
          process.kill(Number(omp[0]), "SIGKILL");
          return true;
        }
        return false;
      }
    } catch {
      /* state not written yet */
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

function descendantPids(rows, rootPid) {
  const found = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (found.has(Number(parent)) && !found.has(Number(pid))) {
        found.add(Number(pid));
        changed = true;
      }
    }
  }
  found.delete(rootPid);
  return found;
}

function telemetryFrom(stdout, stderr) {
  let turns = 0;
  let approvals = 0;
  let retries = 0;
  for (const line of stdout.split("\n")) {
    try {
      const frame = JSON.parse(line);
      if (frame.type === "status" && frame.status === "completed") turns += 1;
      if (
        frame.type === "status" &&
        ["restarting", "resumed"].includes(frame.status)
      )
        retries += 1;
      if (
        frame.type === "tool" &&
        frame.event?.type === "tool_execution_end" &&
        [
          "lhic_browser_execute",
          "lhic_desktop_execute",
          "lhic_desktop_observe",
        ].includes(frame.event?.toolName ?? frame.event?.tool?.name)
      )
        approvals += 1;
    } catch {
      /* non-JSON competitor output */
    }
  }
  if (turns === 0 && stdout.trim()) turns = 1;
  approvals += (stderr.match(/Approve this exact action/g) ?? []).length;
  return { turns, approvals, retries };
}

async function duplicateActions(statePath) {
  try {
    return Number(
      JSON.parse(await readFile(statePath, "utf8")).duplicateVerifiedActions ??
        0,
    );
  } catch {
    return 0;
  }
}

async function selfTest() {
  const coding = await loadManifest("coding");
  const task = coding.value.tasks[0];
  const directory = await mkdtemp(join(tmpdir(), "lhic-benchmark-self-test-"));
  try {
    await mkdir(join(directory, "src"), { recursive: true });
    await writeFile(
      join(directory, "src", "rank.mjs"),
      task.files["src/rank.mjs"],
    );
    const failing = await verifyTask({
      category: "coding",
      task,
      workspace: directory,
    });
    if (failing.passed)
      throw new Error("Broken coding fixture unexpectedly passed.");
    await writeFile(
      join(directory, "src", "rank.mjs"),
      "export function rank(rows){return [...rows].sort((a,b)=>b.score-a.score)}\n",
    );
    const passing = await verifyTask({
      category: "coding",
      task,
      workspace: directory,
    });
    if (!passing.passed) throw new Error(passing.detail);

    const browser = await loadManifest("browser");
    const browserTask = browser.value.tasks[0];
    const statePath = join(directory, "browser-state.json");
    const fixture = await startFixture(
      process.execPath,
      [
        join(benchmarkRoot, "browser", "fixture-server.mjs"),
        browser.path,
        browserTask.id,
        statePath,
      ],
      repositoryRoot,
    );
    try {
      await fetch(`${fixture.ready.url}state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(browserTask.verification.state),
      });
      const verified = await verifyTask({
        category: "browser",
        task: browserTask,
        workspace: directory,
        statePath,
      });
      if (!verified.passed) throw new Error(verified.detail);
    } finally {
      await stopFixture(fixture.child);
    }
    console.log("competitive benchmark self-test passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseArguments(values) {
  const parsed = {
    product: "lhic",
    track: "shared-capability",
    repetitions: 5,
    timeoutMs: 900_000,
    selfTest: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--self-test") parsed.selfTest = true;
    else if (value === "--product")
      parsed.product = required(values[++index], value);
    else if (value === "--track")
      parsed.track = required(values[++index], value);
    else if (value === "--repetitions")
      parsed.repetitions = Number(required(values[++index], value));
    else if (value === "--timeout-ms")
      parsed.timeoutMs = Number(required(values[++index], value));
    else if (value === "--output")
      parsed.output = required(values[++index], value);
    else if (value === "--task") parsed.task = required(values[++index], value);
    else throw new Error(`Unknown argument ${value}.`);
  }
  if (!["lhic", "goose", "codex"].includes(parsed.product))
    throw new Error("--product must be lhic, goose, or codex.");
  if (!["shared-capability", "product-native"].includes(parsed.track))
    throw new Error("--track is invalid.");
  if (!Number.isSafeInteger(parsed.repetitions) || parsed.repetitions < 1)
    throw new Error("--repetitions must be a positive integer.");
  return parsed;
}

function required(value, flag) {
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function hashFile(path) {
  return sha256(await readFile(path));
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function findExecutable(name) {
  if (name.includes("/") || name.includes("\\"))
    return (await exists(name)) ? resolve(name) : undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    for (const suffix of process.platform === "win32"
      ? [".exe", ".cmd", ".bat", ""]
      : [""]) {
      const candidate = join(directory, `${name}${suffix}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}
function resolveElectron() {
  const binary = process.platform === "win32" ? "electron.exe" : "electron";
  return join(repositoryRoot, "node_modules", ".bin", binary);
}
