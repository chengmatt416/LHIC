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
const packageDirectory = await mkdtemp(join(tmpdir(), "lhic-alias-package-"));
const installDirectory = await mkdtemp(join(tmpdir(), "lhic-alias-install-"));

try {
  await runNpm([
    "pack",
    "--workspace",
    "@pinyencheng/lhic",
    "--pack-destination",
    packageDirectory,
  ]);
  await runNpm([
    "pack",
    "--workspace",
    "lhic",
    "--pack-destination",
    packageDirectory,
  ]);
  const archives = await readdir(packageDirectory);
  const coreArchive = archiveNamed(archives, "pinyencheng-lhic-");
  const aliasArchive = archiveNamed(archives, "lhic-");
  await runNpm([
    "install",
    "--prefix",
    installDirectory,
    "--no-package-lock",
    join(packageDirectory, coreArchive),
    join(packageDirectory, aliasArchive),
  ]);
  const { stdout: helpOutput } = await execFileAsync(
    process.execPath,
    [
      join(installDirectory, "node_modules", "lhic", "bin", "lhic.js"),
      "--help",
    ],
    { cwd: installDirectory },
  );
  // Robust forwarding check: the alias help must be the canonical CLI help,
  // which begins with the usage banner and lists the current command set.
  // Assert on the stable prefix and representative commands rather than a
  // fixed first command, so help-text evolution does not break packaging.
  if (
    !/^Usage: lhic \[/.test(helpOutput) ||
    !/\bagent\b/.test(helpOutput) ||
    !/\binstall\b/.test(helpOutput) ||
    !/\bpreflight\b/.test(helpOutput)
  ) {
    throw new Error(
      "The installed lhic compatibility package did not forward to the full CLI.",
    );
  }
  console.log(JSON.stringify({ passed: true, package: "lhic" }, null, 2));
} finally {
  await Promise.all([
    rm(packageDirectory, { recursive: true, force: true }),
    rm(installDirectory, { recursive: true, force: true }),
  ]);
}

function archiveNamed(archives, prefix) {
  const archive = archives.find(
    (name) => name.startsWith(prefix) && name.endsWith(".tgz"),
  );
  if (!archive) throw new Error(`npm pack did not create ${prefix}*.tgz.`);
  return archive;
}

function runNpm(argumentsList) {
  return execFileAsync(npmCommand, ["--loglevel=error", ...argumentsList], {
    cwd: workspaceDirectory,
    maxBuffer: 10 * 1024 * 1024,
    shell: process.platform === "win32",
  });
}
