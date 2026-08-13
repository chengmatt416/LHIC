#!/usr/bin/env node
/**
 * Publishes the LHIC Homebrew tap (chengmatt416/homebrew-lhic).
 *
 *   node scripts/publish-brew-tap.mjs [version] [--push]
 *
 * Refreshes:
 *   - Casks/l/lhic-control-center.rb: mac arm64/x64 dmg checksums taken from
 *     the release's SHA256SUMS-<version>.txt manifest (mac artifacts are
 *     produced by CI; missing entries leave the placeholder and warn).
 *   - Formula/lhic.rb: the CLI formula is bumped to the latest published
 *     @pinyencheng/lhic version and its tarball SHA-256.
 *
 * Without --push the files are rewritten in place (dry run). With --push the
 * tap directory is committed and pushed to LHIC_BREW_TAP_REMOTE (default
 * git@github.com:chengmatt416/homebrew-lhic.git).
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2] ?? "0.2.0";
const push = process.argv.includes("--push");
const baseUrl =
  process.env.LHIC_DESKTOP_BASE_URL ??
  `https://github.com/chengmatt416/LHIC/releases/download/desktop-v${version}`;
const tapDirectory = resolve(
  process.env.LHIC_BREW_TAP_DIR ??
    fileURLToPath(new URL("../distribution/homebrew-lhic", import.meta.url)),
);

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

async function manifestDigests() {
  const text = await fetchText(`${baseUrl}/SHA256SUMS-${version}.txt`);
  const digests = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+(\S+)$/.exec(line.trim());
    if (match) digests.set(match[2], match[1]);
  }
  return digests;
}

async function refreshCask(digests) {
  const path = resolve(tapDirectory, "Casks", "l", "lhic-control-center.rb");
  let cask = await readFile(path, "utf8");
  cask = cask.replace(/version "[\d.]+"/, `version "${version}"`);
  for (const arch of ["arm64", "x64"]) {
    const asset = `lhic-control-center-mac-${version}-${arch}.dmg`;
    const digest = digests.get(asset);
    if (!digest) {
      console.warn(
        `[brew-tap] ${asset} not in the release manifest — leaving the cask checksum placeholder (macOS artifacts are built in CI).`,
      );
      continue;
    }
    const block = arch === "arm64" ? "on_arm" : "on_intel";
    cask = cask.replace(
      new RegExp(
        `(on_${block === "on_arm" ? "arm" : "intel"}\\s+do[\\s\\S]*?sha256 ")[a-f0-9]{64}(")`,
      ),
      `$1${digest}$2`,
    );
  }
  await writeFile(path, cask);
  console.log(`[brew-tap] Refreshed cask lhic-control-center@${version}.`);
}

async function refreshCliFormula() {
  const registry = JSON.parse(
    await fetchText("https://registry.npmjs.org/@pinyencheng/lhic"),
  );
  const latest = registry["dist-tags"]?.latest;
  if (!latest) {
    throw new Error(
      "npm registry did not report a latest @pinyencheng/lhic version.",
    );
  }
  const tarball = registry.versions[latest]?.dist?.tarball;
  if (!tarball) {
    throw new Error(
      `npm registry has no tarball for @pinyencheng/lhic@${latest}.`,
    );
  }
  const bytes = new Uint8Array(await (await fetch(tarball)).arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const tarballName = tarball.split("/").at(-1);
  const path = resolve(tapDirectory, "Formula", "lhic.rb");
  let formula = await readFile(path, "utf8");
  formula = formula.replace(
    /url "https:\/\/registry\.npmjs\.org\/@pinyencheng\/lhic\/-\/lhic-[\d.]+\.tgz"/,
    `url "${tarball}"`,
  );
  formula = formula.replace(/sha256 "[a-f0-9]{64}"/, `sha256 "${sha256}"`);
  await writeFile(path, formula);
  console.log(
    `[brew-tap] Refreshed CLI formula to @pinyencheng/lhic@${latest} (${tarballName}).`,
  );
}

async function main() {
  const digests = await manifestDigests();
  await refreshCask(digests);
  await refreshCliFormula();
  if (!push) {
    console.log(
      "[brew-tap] Dry run complete — files rewritten in place (no git push).",
    );
    return;
  }
  const remote =
    process.env.LHIC_BREW_TAP_REMOTE ??
    "git@github.com:chengmatt416/homebrew-lhic.git";
  execFileSync("git", ["-C", tapDirectory, "add", "-A"], { stdio: "inherit" });
  execFileSync(
    "git",
    [
      "-C",
      tapDirectory,
      "-c",
      "user.name=LHIC Release Bot",
      "-c",
      "user.email=chengmatt416@gmail.com",
      "commit",
      "-m",
      `Update LHIC Control Center ${version}`,
    ],
    { stdio: "inherit" },
  );
  execFileSync("git", ["-C", tapDirectory, "push", remote, "HEAD:main"], {
    stdio: "inherit",
  });
  console.log(`[brew-tap] Pushed to ${remote}.`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
