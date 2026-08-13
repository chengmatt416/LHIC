#!/usr/bin/env node
/**
 * Publishes the lhic-control-center-bin AUR package.
 *
 *   node scripts/publish-aur.mjs [version] [--push]
 *
 * Fills the x86_64/aarch64 AppImage checksums and pkgver from the release
 * manifest into distribution/aur/lhic-control-center-bin/{PKGBUILD,.SRCINFO}.
 * Without --push the files are rewritten in place (dry run). With --push the
 * package directory is committed and pushed to LHIC_AUR_REMOTE (default
 * ssh://aur@aur.archlinux.org/lhic-control-center-bin.git).
 */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2] ?? "0.2.1";
const push = process.argv.includes("--push");
const baseUrl =
  process.env.LHIC_DESKTOP_BASE_URL ??
  `https://github.com/chengmatt416/LHIC/releases/download/desktop-v${version}`;
const packageDirectory = resolve(
  process.env.LHIC_AUR_DIR ??
    fileURLToPath(
      new URL("../distribution/aur/lhic-control-center-bin", import.meta.url),
    ),
);

async function manifestDigests() {
  const response = await fetch(`${baseUrl}/SHA256SUMS-${version}.txt`);
  if (!response.ok) {
    throw new Error(
      `Checksum manifest download failed with HTTP ${response.status}.`,
    );
  }
  const digests = new Map();
  for (const line of (await response.text()).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+(\S+)$/.exec(line.trim());
    if (match) digests.set(match[2], match[1]);
  }
  return digests;
}

async function main() {
  const digests = await manifestDigests();
  const archDigests = {
    x86_64: digests.get(`lhic-control-center-linux-${version}-x64.AppImage`),
    aarch64: digests.get(`lhic-control-center-linux-${version}-arm64.AppImage`),
  };
  for (const [arch, digest] of Object.entries(archDigests)) {
    if (!digest) {
      console.warn(
        `[aur] ${arch} AppImage not in the release manifest — leaving the checksum placeholder (${arch} artifacts are built in CI).`,
      );
    }
  }
  for (const filename of ["PKGBUILD", ".SRCINFO"]) {
    const path = resolve(packageDirectory, filename);
    let content = await readFile(path, "utf8");
    if (filename === "PKGBUILD") {
      content = content
        .replace(/^pkgver=[\d.]+$/m, `pkgver=${version}`)
        .replace(
          /^sha256sums_x86_64=\('[a-f0-9]{64}'\)$/m,
          `sha256sums_x86_64=('${archDigests.x86_64 ?? "0".repeat(64)}')`,
        )
        .replace(
          /^sha256sums_aarch64=\('[a-f0-9]{64}'\)$/m,
          `sha256sums_aarch64=('${archDigests.aarch64 ?? "0".repeat(64)}')`,
        );
    } else {
      content = content
        .replace(/^\tpkgver = [\d.]+$/m, `\tpkgver = ${version}`)
        .replace(
          /^\tsha256sums_x86_64 = [a-f0-9]{64}$/m,
          `\tsha256sums_x86_64 = ${archDigests.x86_64 ?? "0".repeat(64)}`,
        )
        .replace(
          /^\tsha256sums_aarch64 = [a-f0-9]{64}$/m,
          `\tsha256sums_aarch64 = ${archDigests.aarch64 ?? "0".repeat(64)}`,
        );
    }
    await writeFile(path, content);
  }
  console.log(`[aur] Refreshed lhic-control-center-bin@${version}.`);
  if (!push) {
    console.log(
      "[aur] Dry run complete — files rewritten in place (no git push).",
    );
    return;
  }
  const remote =
    process.env.LHIC_AUR_REMOTE ??
    "ssh://aur@aur.archlinux.org/lhic-control-center-bin.git";
  execFileSync("git", ["-C", packageDirectory, "add", "-A"], {
    stdio: "inherit",
  });
  execFileSync(
    "git",
    [
      "-C",
      packageDirectory,
      "-c",
      "user.name=LHIC Release Bot",
      "-c",
      "user.email=chengmatt416@gmail.com",
      "commit",
      "-m",
      `Update lhic-control-center-bin to ${version}`,
    ],
    { stdio: "inherit" },
  );
  execFileSync("git", ["-C", packageDirectory, "push", remote, "HEAD:master"], {
    stdio: "inherit",
  });
  console.log(`[aur] Pushed to ${remote}.`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
