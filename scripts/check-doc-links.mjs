import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const { stdout } = await execFileAsync("git", ["ls-files", "--", "*.md"], {
  cwd: workspaceDirectory,
});
const markdownFiles = stdout.trim().split("\n").filter(Boolean);
const failures = [];

for (const file of markdownFiles) {
  const absoluteFile = resolve(workspaceDirectory, file);
  const content = await readFile(absoluteFile, "utf8");
  for (const target of extractTargets(content)) {
    if (isExternalTarget(target)) {
      continue;
    }
    const relativeTarget = target.split(/[?#]/, 1)[0];
    if (!relativeTarget) {
      continue;
    }
    const resolvedTarget = resolve(dirname(absoluteFile), relativeTarget);
    if (!isInsideWorkspace(resolvedTarget) || !(await exists(resolvedTarget))) {
      failures.push(`${file}: ${target}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Local Markdown links failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Local Markdown link check passed: ${markdownFiles.length} files.`,
  );
}

function extractTargets(content) {
  return [
    ...content.matchAll(/!?\[[^\]]*]\((?:<)?([^\s)>]+)(?:>)?(?:\s+[^)]*)?\)/g),
  ].map((match) => match[1] ?? "");
}

function isExternalTarget(target) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
}

function isInsideWorkspace(filePath) {
  return (
    filePath === workspaceDirectory ||
    filePath.startsWith(`${workspaceDirectory}/`)
  );
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
