import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const packageVersion = process.argv[2];

if (!packageVersion) {
  throw new Error(
    "Usage: npm run package:published-smoke -- <published-package-version>",
  );
}

const packageSpec = `@pinyencheng/lhic@${packageVersion}`;
const workDirectory = await mkdtemp(join(tmpdir(), "lhic-published-smoke-"));
const npmCacheDirectory = await mkdtemp(join(tmpdir(), "lhic-npm-cache-"));
const browserDirectory = await mkdtemp(join(tmpdir(), "lhic-browser-cache-"));
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

try {
  await runNpx([
    "--yes",
    `--package=${packageSpec}`,
    "playwright",
    "install",
    "chromium",
  ]);
  const { stdout } = await runNpx(["--yes", packageSpec, "demo"]);
  const report = JSON.parse(stdout);

  if (!report.passed || report.gpt56?.enabled) {
    throw new Error(
      "Published safe demo did not pass with the GPT Slow Path disabled.",
    );
  }

  console.log(
    JSON.stringify(
      {
        package: packageSpec,
        passed: report.passed,
        localExecution: report.localExecution,
        approvalGate: report.approvalGate,
        gpt56: report.gpt56,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all([
    rm(workDirectory, { recursive: true, force: true }),
    rm(npmCacheDirectory, { recursive: true, force: true }),
    rm(browserDirectory, { recursive: true, force: true }),
  ]);
}

function runNpx(argumentsList) {
  return execFileAsync(npxCommand, ["--loglevel=error", ...argumentsList], {
    cwd: workDirectory,
    env: demoEnvironment(),
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}

function demoEnvironment() {
  const environment = {
    ...process.env,
    OPENAI_SLOW_PATH_ENABLED: "false",
    npm_config_cache: npmCacheDirectory,
    PLAYWRIGHT_BROWSERS_PATH: browserDirectory,
  };
  delete environment.OPENAI_API_KEY;
  delete environment.LHIC_OPENAI_API_KEY;
  return environment;
}
