import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const packageDirectory = await mkdtemp(join(tmpdir(), "lhic-package-smoke-"));
const installDirectory = await mkdtemp(join(tmpdir(), "lhic-install-smoke-"));

try {
  await runNpm(
    [
      "pack",
      "--workspace",
      "@pinyencheng/lhic",
      "--pack-destination",
      packageDirectory,
    ],
    workspaceDirectory,
  );
  const archive = await findArchive(packageDirectory);
  await runNpm(
    ["install", "--prefix", installDirectory, "--no-package-lock", archive],
    workspaceDirectory,
  );
  await runNpm(
    [
      "exec",
      "--prefix",
      installDirectory,
      "--",
      "playwright",
      "install",
      "chromium",
    ],
    installDirectory,
  );
  const { stdout } = await runNpm(
    ["exec", "--prefix", installDirectory, "--", "lhic", "demo", "--safe"],
    installDirectory,
    demoEnvironment(),
  );
  const report = JSON.parse(stdout);
  if (!report.passed || report.gpt56?.enabled) {
    throw new Error(
      "Packaged safe demo did not pass with the GPT Slow Path disabled.",
    );
  }
  console.log(
    JSON.stringify(
      {
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
    rm(packageDirectory, { recursive: true, force: true }),
    rm(installDirectory, { recursive: true, force: true }),
  ]);
  await execFileAsync(
    process.execPath,
    ["apps/cli/scripts/prepare-package.mjs"],
    {
      cwd: workspaceDirectory,
    },
  );
}

async function findArchive(directory) {
  const files = await readdir(directory);
  const archive = files.find((file) => file.endsWith(".tgz"));
  if (!archive) {
    throw new Error("npm pack did not create a tarball.");
  }
  return join(directory, archive);
}

async function runNpm(argumentsList, cwd, env = process.env) {
  return execFileAsync(npmCommand, ["--loglevel=error", ...argumentsList], {
    cwd,
    env,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}

function demoEnvironment() {
  const environment = {
    ...process.env,
    OPENAI_SLOW_PATH_ENABLED: "false",
  };
  delete environment.OPENAI_API_KEY;
  delete environment.LHIC_OPENAI_API_KEY;
  return environment;
}
