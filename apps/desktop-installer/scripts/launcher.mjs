#!/usr/bin/env node
/**
 * Cross-platform launcher for the LHIC Control Center desktop app.
 *
 * On first run it downloads the platform installer artifact for the matching
 * release from the lhic.techtools.qzz.io mirror (or GitHub, whichever is
 * reachable), verifies it against the release's SHA256SUMS manifest, caches
 * it under the user cache directory, and launches it. Zero dependencies —
 * plain Node.js >= 18.
 *
 * Env overrides (also used by the CI publish flow and local testing):
 *   LHIC_DESKTOP_VERSION   - release version (default: package version)
 *   LHIC_DESKTOP_BASE_URL  - release download base URL (default: the mirror)
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
const VERSION = process.env.LHIC_DESKTOP_VERSION ?? packageVersion;
const MIRROR_BASE_URL = `https://lhic.techtools.qzz.io/release`;
const GITHUB_BASE_URL = `https://github.com/chengmatt416/LHIC/releases/download/desktop-v${VERSION}`;
const BASE_URL = process.env.LHIC_DESKTOP_BASE_URL ?? MIRROR_BASE_URL;
const BASE_URLS = [...new Set([BASE_URL, MIRROR_BASE_URL, GITHUB_BASE_URL])];

const assetForPlatform = {
  darwin: {
    arm64: `lhic-control-center-mac-${VERSION}-arm64.zip`,
    x64: `lhic-control-center-mac-${VERSION}-x64.zip`,
  },
  linux: {
    arm64: `lhic-control-center-linux-${VERSION}-arm64.AppImage`,
    x64: `lhic-control-center-linux-${VERSION}-x64.AppImage`,
  },
  win32: {
    x64: `lhic-control-center-win-${VERSION}-x64.exe`,
  },
};

function cacheDirectory() {
  if (process.platform === "win32") {
    const local =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "lhic-desktop", VERSION);
  }
  const cacheRoot = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheRoot, "lhic-desktop", VERSION);
}

async function manifestDigest(asset) {
  let text;
  for (const base of BASE_URLS) {
    try {
      const response = await fetch(`${base}/SHA256SUMS-${VERSION}.txt`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      text = await response.text();
      break;
    } catch {
      // Try the next base (mirror, then GitHub).
    }
  }
  if (text === undefined) {
    throw new Error(
      `LHIC desktop checksum manifest download failed on all mirrors.`,
    );
  }
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trimEnd().endsWith(`  ${asset}`));
  if (!line) {
    throw new Error(
      `LHIC desktop checksum manifest has no entry for ${asset}.`,
    );
  }
  const digest = line.trim().split(/\s+/, 1)[0];
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`LHIC desktop checksum for ${asset} is invalid.`);
  }
  return digest;
}

async function sha256File(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function ensureArtifact(asset, targetPath) {
  let cachedDigest;
  try {
    cachedDigest = await sha256File(targetPath);
  } catch {
    cachedDigest = undefined;
  }
  if (cachedDigest) {
    try {
      const expected = await manifestDigest(asset);
      if (cachedDigest === expected) {
        return;
      }
      await rm(targetPath, { force: true });
    } catch (error) {
      // Network failure on every mirror: reuse the verified cache rather than
      // breaking an offline install.
      console.warn(
        `Network unavailable (${error instanceof Error ? error.message : String(error)}); reusing cached artifact at ${targetPath}.`,
      );
      return;
    }
  }
  const expected = await manifestDigest(asset);
  let bytes;
  for (const base of BASE_URLS) {
    try {
      const response = await fetch(`${base}/${asset}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
      break;
    } catch {
      // Try the next base (mirror, then GitHub).
    }
  }
  if (bytes === undefined) {
    throw new Error(`LHIC desktop download failed on all mirrors (${asset}).`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    await rm(targetPath, { force: true });
    throw new Error(
      `LHIC desktop SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}.`,
    );
  }
  await writeFile(targetPath, bytes);
  if (process.platform !== "win32") {
    await chmod(targetPath, 0o755);
  }
}

function launchLinux(appImagePath) {
  // Try the FUSE runtime first; if the AppImage exits within two seconds
  // (missing libfuse on WSL/containers/minimal distros), fall back to
  // --appimage-extract-and-run, which needs no FUSE at all.
  const attempt = (extraArgs) =>
    new Promise((resolve) => {
      const child = spawn(appImagePath, extraArgs, {
        stdio: "inherit",
        detached: true,
      });
      child.unref();
      const timer = setTimeout(() => resolve(true), 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  void attempt([]).then((survived) => {
    if (!survived) {
      void attempt(["--appimage-extract-and-run"]);
    }
  });
}

async function launchMac(asset, targetPath) {
  const appDirectory = join(cacheDirectory(), "LHIC Control Center.app");
  try {
    await stat(appDirectory);
  } catch {
    const zip = targetPath;
    await new Promise((resolve, reject) => {
      execFile("unzip", ["-o", "-q", zip, "-d", cacheDirectory()], (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }
  const child = spawn("open", [appDirectory], { stdio: "inherit" });
  child.once("error", (error) => {
    console.error(`Launch failed: ${error.message}`);
  });
}

function launchWindows(exePath) {
  const child = spawn(exePath, [], { stdio: "inherit", detached: true });
  child.unref();
  child.once("error", (error) => {
    console.error(`Launch failed: ${error.message}`);
  });
}

async function main() {
  const provisionRequested = process.argv.includes("provision");
  if (provisionRequested || (await shouldProvision())) {
    await runProvisioner();
    if (provisionRequested) {
      return;
    }
  }
  const asset = assetForPlatform[process.platform]?.[process.arch];
  if (!asset) {
    throw new Error(
      `Unsupported LHIC desktop platform/arch: ${process.platform}/${process.arch}`,
    );
  }
  const directory = cacheDirectory();
  await mkdir(directory, { recursive: true });
  const targetPath = join(directory, asset);
  await ensureArtifact(asset, targetPath);
  console.log(`Launching LHIC Control Center ${VERSION}…`);
  if (process.platform === "darwin") {
    await launchMac(asset, targetPath);
  } else if (process.platform === "linux") {
    launchLinux(targetPath);
  } else {
    launchWindows(targetPath);
  }
}

async function shouldProvision() {
  if (process.env.LHIC_SKIP_BACKENDS === "1") return false;
  try {
    await stat(join(cacheDirectory(), "provisioned.json"));
    return false;
  } catch {
    return true;
  }
}

async function runProvisioner() {
  const script = fileURLToPath(
    new URL("./provision-backends.mjs", import.meta.url),
  );
  const code = await new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [script], { stdio: "inherit" });
    child.once("exit", (code) => resolvePromise(code ?? 1));
    child.once("error", () => resolvePromise(1));
  });
  if (!process.argv.includes("provision")) {
    await mkdir(cacheDirectory(), { recursive: true });
    await writeFile(
      join(cacheDirectory(), "provisioned.json"),
      `${JSON.stringify({ version: VERSION, provisionedAt: new Date().toISOString(), exitCode: code }, null, 2)}\n`,
    );
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
