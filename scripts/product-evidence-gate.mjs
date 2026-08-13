#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArguments(process.argv.slice(2));
const outputPath = resolve(
  root,
  options.output ?? "artifacts/product-evidence.json",
);
const checks = [];
checks.push(
  await runCheck("benchmark-fixture-self-test", process.execPath, [
    "benchmarks/agent-competitive/run.mjs",
    "--self-test",
  ]),
);
checks.push(
  await runCheck("evidence-contract-tests", resolveExecutable("npx"), [
    "vitest",
    "run",
    "apps/cli/src/competitive-benchmark-evidence.test.ts",
    "apps/cli/src/external-benchmark-evidence.test.ts",
  ]),
);

let competitiveEvidence;
if (options.competitive) {
  if (!options.comparator)
    throw new Error("--competitive requires --comparator goose or codex.");
  const validation = await runCheck(
    "live-competitive-evidence",
    resolveExecutable("npx"),
    [
      "tsx",
      "apps/cli/src/main.ts",
      "bench",
      "validate-competitive",
      resolve(options.competitive),
      options.comparator,
    ],
  );
  checks.push(validation);
  competitiveEvidence = {
    path: resolve(options.competitive),
    sha256: hash(await readFile(resolve(options.competitive))),
    comparator: options.comparator,
    claimAllowed: validation.passed,
  };
}

const ungroundedClaims = await findUngroundedClaims(
  join(root, "apps", "desktop", "src"),
);
if (ungroundedClaims.length > 0 && !competitiveEvidence?.claimAllowed) {
  checks.push({
    name: "competitive-claim-grounding",
    passed: false,
    command: "static desktop source scan",
    stdout: "",
    stderr: `Ungrounded competitive claims: ${ungroundedClaims.join(", ")}`,
  });
} else {
  checks.push({
    name: "competitive-claim-grounding",
    passed: true,
    command: "static desktop source scan",
    stdout: competitiveEvidence?.claimAllowed
      ? "Suite-scoped claim is backed by supplied evidence."
      : "No competitive product claim is shipped.",
    stderr: "",
  });
}

const fixtureFiles = ["coding", "browser", "desktop"].map((category) =>
  join(root, "benchmarks", "agent-competitive", category, "fixtures.json"),
);
const fixtureBytes = await Promise.all(
  fixtureFiles.map((path) => readFile(path)),
);
const packageJson = JSON.parse(
  await readFile(join(root, "apps", "desktop", "package.json"), "utf8"),
);
const report = {
  schemaVersion: "lhic-product-evidence-v1",
  generatedAt: new Date().toISOString(),
  release: {
    desktopVersion: packageJson.version,
    ompVersion: process.env.OMP_VERSION ?? "17.2.15",
  },
  fixtureSetSha256: hash(Buffer.concat(fixtureBytes)),
  checks: checks.map(({ name, passed, command }) => ({
    name,
    passed,
    command,
  })),
  competitiveEvidence: competitiveEvidence ?? {
    claimAllowed: false,
    reason:
      "No live same-model competitive evidence supplied; release contains no superiority claim.",
  },
};
const failed = checks.filter((check) => !check.passed);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
for (const check of checks) {
  console.log(
    `${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.command}`,
  );
  if (!check.passed && check.stderr) console.error(check.stderr);
}
console.log(`Product evidence: ${outputPath}`);
if (failed.length > 0) process.exitCode = 1;

async function runCheck(name, executable, args) {
  const result = await capture(executable, args);
  return {
    name,
    passed: result.exitCode === 0,
    command: [executable, ...args].join(" "),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function capture(executable, args) {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (exitCode) =>
      resolveResult({ exitCode, stdout, stderr }),
    );
  });
}

async function findUngroundedClaims(directory) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      matches.push(...(await findUngroundedClaims(path)));
    else if ([".ts", ".tsx", ".js", ".jsx"].includes(extname(path))) {
      const source = await readFile(path, "utf8");
      if (
        /\b(?:outperforms?|beats?)\s+(?:goose|codex)\b|\bstate[- ]of[- ]the[- ]art\b|\bSOTA\b/i.test(
          source,
        )
      ) {
        matches.push(path.slice(root.length + 1));
      }
    }
  }
  return matches;
}

function parseArguments(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--output") parsed.output = required(values[++index], value);
    else if (value === "--competitive")
      parsed.competitive = required(values[++index], value);
    else if (value === "--comparator")
      parsed.comparator = required(values[++index], value);
    else throw new Error(`Unknown argument ${value}.`);
  }
  if (
    parsed.comparator &&
    parsed.comparator !== "goose" &&
    parsed.comparator !== "codex"
  ) {
    throw new Error("--comparator must be goose or codex.");
  }
  return parsed;
}
function required(value, flag) {
  if (!value) throw new Error(`${flag} requires a value.`);
  return value;
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function resolveExecutable(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}
