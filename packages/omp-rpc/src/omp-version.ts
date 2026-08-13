import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_OMP_VERSION = "17.2.15";
const OMP_RELEASE_REPO = "can1357/oh-my-pi";
const defaultCheckIntervalMs = 6 * 60 * 60 * 1_000;

const assetForPlatform: Record<string, Record<string, string>> = {
  darwin: { arm64: "omp-darwin-arm64", x64: "omp-darwin-x64" },
  linux: { arm64: "omp-linux-arm64", x64: "omp-linux-x64" },
  win32: { x64: "omp-windows-x64.exe" },
};

export interface OmpUpdaterOptions {
  /** Directory that holds one subdirectory per omp version. */
  cacheRoot?: string;
  /** Version to treat as current when no auto-update has happened. */
  pinnedVersion?: string;
  /** Set false (or env LHIC_DISABLE_OMP_UPDATE=1) to disable update checks. */
  updateCheckEnabled?: boolean;
  /** How often to re-check the latest release (ms). */
  checkIntervalMs?: number;
  fetchImplementation?: typeof fetch;
  /** Pre-resolved binary for the pinned version (e.g. the packaged app). */
  bundledBinary?: string;
}

export function isNewerOmpVersion(candidate: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, "")
      .split(".")
      .map((part) => Number(part))
      .map((part) => (Number.isFinite(part) ? part : 0));
  const left = parse(candidate);
  const right = parse(current);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function cacheRootFor(options: OmpUpdaterOptions): string {
  return (
    options.cacheRoot ??
    process.env.LHIC_OMP_CACHE_DIR ??
    join(homedir(), ".cache", "lhic", "omp")
  );
}

function pinnedVersionFor(options: OmpUpdaterOptions): string {
  return (
    options.pinnedVersion ?? process.env.OMP_VERSION ?? DEFAULT_OMP_VERSION
  );
}

function assetFor(): string {
  const byArch = assetForPlatform[process.platform];
  const asset = byArch?.[process.arch];
  if (!asset) {
    throw new Error(
      `Unsupported omp platform/arch: ${process.platform}/${process.arch}`,
    );
  }
  return asset;
}

function binaryPath(cacheRoot: string, version: string): string {
  return join(
    cacheRoot,
    version,
    process.platform === "win32" ? "omp.exe" : "omp",
  );
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

async function fetchText(
  fetchImplementation: typeof fetch,
  url: string,
): Promise<string> {
  const response = await fetchImplementation(url, {
    headers: { "User-Agent": "lhic-omp-updater" },
  });
  if (!response.ok) {
    throw new Error(`download failed with HTTP ${response.status}: ${url}`);
  }
  return response.text();
}

async function manifestDigest(
  fetchImplementation: typeof fetch,
  version: string,
  asset: string,
): Promise<string> {
  const base = `https://github.com/${OMP_RELEASE_REPO}/releases/download/v${version}`;
  const text = await fetchText(fetchImplementation, `${base}/SHA256SUMS.txt`);
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.trimEnd().endsWith(` ${asset}`));
  if (!line) {
    throw new Error(`omp release manifest has no entry for ${asset}.`);
  }
  const digest = line.trim().split(/\s+/, 1)[0] ?? "";
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`omp release manifest digest for ${asset} is invalid.`);
  }
  return digest;
}

async function ensureVersion(
  fetchImplementation: typeof fetch,
  cacheRoot: string,
  version: string,
): Promise<string | undefined> {
  const asset = assetFor();
  const targetPath = binaryPath(cacheRoot, version);
  try {
    const cached = await sha256File(targetPath);
    const expected = await manifestDigest(fetchImplementation, version, asset);
    if (cached === expected) {
      return targetPath;
    }
    await rm(targetPath, { force: true });
  } catch {
    try {
      await stat(targetPath);
      return targetPath; // Network unavailable; reuse the cached binary.
    } catch {
      // No cache yet; download below.
    }
  }
  try {
    await mkdir(join(cacheRoot, version), { recursive: true });
    const base = `https://github.com/${OMP_RELEASE_REPO}/releases/download/v${version}`;
    const response = await fetchImplementation(`${base}/${asset}`, {
      headers: { "User-Agent": "lhic-omp-updater" },
    });
    if (!response.ok) {
      throw new Error(
        `omp binary download failed with HTTP ${response.status}.`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expected = await manifestDigest(fetchImplementation, version, asset);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      await rm(targetPath, { force: true });
      throw new Error(
        `omp binary SHA-256 mismatch for v${version}: expected ${expected}, got ${actual}.`,
      );
    }
    await writeFile(targetPath, bytes);
    if (process.platform !== "win32") {
      await chmod(targetPath, 0o755);
    }
    return targetPath;
  } catch (error) {
    try {
      await stat(targetPath);
      return targetPath; // Partial failure; reuse whatever exists.
    } catch {
      throw error;
    }
  }
}

interface LatestMarker {
  version?: string;
  checkedAt?: string;
}

async function readLatestMarker(cacheRoot: string): Promise<LatestMarker> {
  try {
    const parsed = JSON.parse(
      await readFile(join(cacheRoot, "latest.json"), "utf8"),
    ) as Record<string, unknown>;
    return {
      ...(typeof parsed.version === "string"
        ? { version: parsed.version }
        : {}),
      ...(typeof parsed.checkedAt === "string"
        ? { checkedAt: parsed.checkedAt }
        : {}),
    };
  } catch {
    return {};
  }
}

async function latestOmpVersion(
  fetchImplementation: typeof fetch,
): Promise<string | undefined> {
  const response = await fetchImplementation(
    `https://api.github.com/repos/${OMP_RELEASE_REPO}/releases/latest`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "lhic-omp-updater",
      },
    },
  );
  if (!response.ok) {
    return undefined;
  }
  const payload = (await response.json()) as { tag_name?: unknown };
  if (typeof payload.tag_name !== "string") {
    return undefined;
  }
  const version = payload.tag_name.replace(/^v/, "");
  return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}

/**
 * Resolves the omp RPC binary, automatically updating the omp core when a
 * newer release exists:
 *   1. `OMP_BINARY` env override wins.
 *   2. The pinned version is ensured (cache, else the bundled binary when
 *      provided, else a fresh download) — SHA-256 verified per release.
 *   3. The latest omp release is checked (GitHub API, TTL-cached); when it
 *      is newer, that version is downloaded into the cache and returned.
 * Any update failure falls back to the current binary; nothing ever breaks
 * an existing install. Disable checks with LHIC_DISABLE_OMP_UPDATE=1.
 */
export async function resolveOmpBinary(
  options: OmpUpdaterOptions = {},
): Promise<string> {
  if (process.env.OMP_BINARY) {
    return process.env.OMP_BINARY;
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const cacheRoot = cacheRootFor(options);
  const pinned = pinnedVersionFor(options);
  const currentPath =
    options.bundledBinary ??
    (await ensureVersion(fetchImplementation, cacheRoot, pinned));
  const updateCheckEnabled =
    options.updateCheckEnabled ?? process.env.LHIC_DISABLE_OMP_UPDATE !== "1";
  if (!updateCheckEnabled || !currentPath) {
    return (
      currentPath ??
      (await ensureVersion(fetchImplementation, cacheRoot, pinned))!
    );
  }
  const marker = await readLatestMarker(cacheRoot);
  const intervalMs = options.checkIntervalMs ?? defaultCheckIntervalMs;
  const stale =
    !marker.checkedAt ||
    Date.parse(marker.checkedAt) <= Date.now() - intervalMs;
  let latest = stale ? undefined : marker.version;
  if (stale) {
    try {
      latest = await latestOmpVersion(fetchImplementation);
    } catch {
      latest = marker.version; // Keep the last known latest on API failure.
    }
    const nextMarker: LatestMarker = {
      ...(latest ? { version: latest } : {}),
      checkedAt: new Date().toISOString(),
    };
    await mkdir(cacheRoot, { recursive: true }).catch(() => undefined);
    await writeFile(
      join(cacheRoot, "latest.json"),
      `${JSON.stringify(nextMarker)}\n`,
    ).catch(() => undefined);
  }
  if (latest && isNewerOmpVersion(latest, pinned)) {
    try {
      const updated = await ensureVersion(
        fetchImplementation,
        cacheRoot,
        latest,
      );
      if (updated) {
        return updated;
      }
    } catch {
      // Fall through to the current binary.
    }
  }
  return currentPath;
}
