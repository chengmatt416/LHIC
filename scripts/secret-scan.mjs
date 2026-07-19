import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const workspaceDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const patterns = [
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  ],
  ["GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  // Current OpenAI keys are materially longer than a short test sentinel.
  // Keep this high-confidence scan conservative; provider-side scanners cover
  // broader heuristic matching during publication.
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["private key block", /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ["Slack token", /\bxox(?:b|p|a|r|s)-[A-Za-z0-9-]{20,}\b/],
  ["Stripe live secret", /\bsk_live_[A-Za-z0-9]{20,}\b/],
];

const { stdout } = await execFileAsync(
  "git",
  ["log", "-p", "--all", "--no-ext-diff", "--format=%H"],
  {
    cwd: workspaceDirectory,
    maxBuffer: 50 * 1024 * 1024,
  },
);
const matches = patterns
  .filter(([, pattern]) => pattern.test(stdout))
  .map(([name]) => name);

if (matches.length > 0) {
  console.error(
    `Secret scan failed for: ${matches.join(", ")}. Matched values are intentionally redacted.`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Secret scan passed: ${patterns.length} high-confidence credential patterns checked across reachable Git history.`,
  );
}
