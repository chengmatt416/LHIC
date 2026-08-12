#!/usr/bin/env node
/**
 * Fetches the omp RPC engine binary into apps/desktop/vendor/omp/current and
 * gates it on the release's SHA256SUMS.txt manifest.
 *
 * Env overrides:
 *   OMP_VERSION   - release tag version (default "17.2.15")
 *   OMP_BASE_URL  - release download base (default GitHub releases URL)
 *
 * The cached file is re-verified against the manifest on every run; a corrupt
 * or mismatched cache is deleted and re-downloaded. A previously fetched cache
 * is reused (with a warning) when the network is unavailable, so CI builds
 * never break on a transient download failure.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OMP_VERSION = process.env.OMP_VERSION ?? "17.2.15";
const OMP_BASE_URL =
  process.env.OMP_BASE_URL ??
  `https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}`;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(
  scriptDirectory,
  "..",
  "vendor",
  "omp",
  "current",
);

const assetForPlatform = {
  darwin: { arm64: "omp-darwin-arm64", x64: "omp-darwin-x64" },
  linux: { arm64: "omp-linux-arm64", x64: "omp-linux-x64" },
  win32: { x64: "omp-windows-x64.exe" },
};

function resolveAsset() {
  const byArch = assetForPlatform[process.platform];
  const asset = byArch?.[process.arch];
  if (!asset) {
    throw new Error(
      `Unsupported omp platform/arch: ${process.platform}/${process.arch}`,
    );
  }
  return asset;
}

function outputFileName() {
  return process.platform === "win32" ? "omp.exe" : "omp";
}

async function manifestHash(asset) {
  const response = await fetch(`${OMP_BASE_URL}/SHA256SUMS.txt`);
  if (!response.ok) {
    throw new Error(
      `omp SHA256SUMS.txt download failed with HTTP ${response.status}.`,
    );
  }
  const text = await response.text();
  const expected = ` ${asset}`;
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trimEnd().endsWith(expected));
  if (!line) {
    throw new Error(`omp release manifest has no entry for ${asset}.`);
  }
  const digest = line.trim().split(/\s+/, 1)[0];
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`omp release manifest digest for ${asset} is invalid.`);
  }
  return digest;
}

async function sha256File(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function downloadAsset(asset, targetPath) {
  const response = await fetch(`${OMP_BASE_URL}/${asset}`);
  if (!response.ok) {
    throw new Error(
      `omp binary download failed with HTTP ${response.status}.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = await manifestHash(asset);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    await rm(targetPath, { force: true });
    throw new Error(
      `omp binary SHA-256 mismatch for ${asset}: expected ${expected}, got ${actual}.`,
    );
  }
  await writeFile(targetPath, bytes);
  if (process.platform !== "win32") {
    await chmod(targetPath, 0o755);
  }
  return actual;
}

async function main() {
  const asset = resolveAsset();
  const targetPath = join(outputDirectory, outputFileName());

  let cachedDigest;
  try {
    cachedDigest = await sha256File(targetPath);
  } catch {
    cachedDigest = undefined;
  }

  if (cachedDigest) {
    let expected;
    try {
      expected = await manifestHash(asset);
    } catch (error) {
      console.warn(
        `Network unavailable (${error instanceof Error ? error.message : String(error)}); reusing cached omp binary at ${targetPath}.`,
      );
      return;
    }
    if (cachedDigest === expected) {
      console.log(
        `omp ${OMP_VERSION} cache verified: ${targetPath} (sha256 ${cachedDigest}).`,
      );
      return;
    }
    await rm(targetPath, { force: true });
  }

  try {
    const digest = await downloadAsset(asset, targetPath);
    console.log(
      `omp ${OMP_VERSION} fetched: ${targetPath} (sha256 ${digest}).`,
    );
  } catch (error) {
    try {
      await stat(targetPath);
      console.warn(
        `Network unavailable (${error instanceof Error ? error.message : String(error)}); reusing cached omp binary at ${targetPath}.`,
      );
      return;
    } catch {
      throw error;
    }
  }
}

await mkdir(outputDirectory, { recursive: true });
await main();
