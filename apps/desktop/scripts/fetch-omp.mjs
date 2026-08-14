#!/usr/bin/env node
/**
 * Fetches the omp RPC engine binary into apps/desktop/vendor/omp/current and
 * gates it on the release's SHA256SUMS.txt manifest.
 *
 * Env overrides:
 *   OMP_VERSION   - release tag version (default "17.2.15")
 *   OMP_BASE_URL  - release download base (default GitHub releases URL)
 *
 * The cached file is verified against an independently pinned release digest
 * for supported production versions. Unknown/custom versions require a live
 * release manifest. Network failure never authorizes an unverified cache.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OMP_VERSION = process.env.OMP_VERSION ?? "17.2.15";
const OMP_BASE_URL =
  process.env.OMP_BASE_URL ??
  `https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}`;

const trustedReleaseDigests = {
  "17.2.15": {
    "omp-darwin-arm64":
      "e280d25bc7ad889c87af101a8b9c8b7aa9853c373acb259eda6007a9659ac2a5",
    "omp-darwin-x64":
      "019281f10e416bc19716c29fc8928b7278573c7a011bcaf22d15dfd39b045d03",
    "omp-linux-arm64":
      "36507ba3d98332f52649d22009ead86f154ab007cb169d68690fa2b0111769ad",
    "omp-linux-x64":
      "fa884941f932f4f5d2046acba971790ae6aae18fd4806472b01f041de670368a",
    "omp-windows-x64.exe":
      "d10d6281ce9993ef0454b2760afa67f5e99a0e092aad4d9fee2068381103c1aa",
  },
};

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

async function expectedHash(asset) {
  const pinned = trustedReleaseDigests[OMP_VERSION]?.[asset];
  if (pinned) return pinned;
  return manifestHash(asset);
}

async function sha256File(path) {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function downloadAsset(asset, targetPath) {
  const response = await fetch(`${OMP_BASE_URL}/${asset}`);
  if (!response.ok) {
    throw new Error(`omp binary download failed with HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const expected = await expectedHash(asset);
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
  const expected = await expectedHash(asset);

  let cachedDigest;
  try {
    cachedDigest = await sha256File(targetPath);
  } catch {
    cachedDigest = undefined;
  }

  if (cachedDigest) {
    if (cachedDigest === expected) {
      console.log(
        `omp ${OMP_VERSION} cache verified: ${targetPath} (sha256 ${cachedDigest}).`,
      );
      return;
    }
    await rm(targetPath, { force: true });
  }

  const digest = await downloadAsset(asset, targetPath);
  console.log(`omp ${OMP_VERSION} fetched: ${targetPath} (sha256 ${digest}).`);
}

await mkdir(outputDirectory, { recursive: true });
await main();
