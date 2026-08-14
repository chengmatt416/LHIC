import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_OMP_VERSION = "17.2.15";
const OMP_RELEASE_REPO = "can1357/oh-my-pi";
const defaultCheckIntervalMs = 6 * 60 * 60 * 1_000;
const trustedRecordFileName = "trusted.json";

const assetForPlatform: Record<string, Record<string, string>> = {
  darwin: { arm64: "omp-darwin-arm64", x64: "omp-darwin-x64" },
  linux: { arm64: "omp-linux-arm64", x64: "omp-linux-x64" },
  win32: { x64: "omp-windows-x64.exe" },
};

/**
 * Immutable local record of a successfully verified omp binary. Written once
 * a release manifest (or an explicit policy digest) has been matched against
 * the actual cached bytes; consulted when the network is unavailable so that
 * only previously trusted binaries run offline.
 */
export interface TrustedBinaryRecord {
  version: string;
  asset: string;
  sha256: string;
  verifiedFrom: string;
  verifiedAt: string;
}

/**
 * Version selection policy for the omp core binary.
 * - `pinned`: exactly `version`; never auto-updates. `digest` additionally
 *   anchors the executable to a specific SHA-256 (the pin itself is a trust
 *   anchor and works offline).
 * - `managed`: the current pinned version is ensured, then the latest stable
 *   release is applied when it is newer (subject to the update-check TTL and
 *   `LHIC_DISABLE_OMP_UPDATE=1`). Suitable for development/production when
 *   the RPC compatibility gate is enforced at startup.
 * - `development-latest`: same resolver behavior as `managed`; use only for
 *   local development, never for benchmarks or releases.
 */
export type OmpVersionPolicy =
  | { mode: "pinned"; version: string; digest?: string }
  | { mode: "managed"; channel?: "stable"; maxProtocolVersion?: number }
  | { mode: "development-latest" };

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
  /**
   * Version policy. Defaults to `{ mode: "managed" }`, which preserves the
   * historical auto-update behavior. Benchmark and release paths MUST use
   * `{ mode: "pinned" }` so runs never silently change the omp core.
   */
  policy?: OmpVersionPolicy;
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

function trustedRecordPath(cacheRoot: string, version: string): string {
  return join(cacheRoot, version, trustedRecordFileName);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  digest.update(await readFile(path));
  return digest.digest("hex");
}

function isTrustedBinaryRecord(
  value: unknown,
  version: string,
  asset: string,
): value is TrustedBinaryRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    // The record is bound to exactly this version and asset: a record moved
    // from another version directory can never authorize execution.
    record.version === version &&
    record.asset === asset &&
    typeof record.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(record.sha256) &&
    typeof record.verifiedFrom === "string" &&
    record.verifiedFrom.length > 0 &&
    typeof record.verifiedAt === "string" &&
    Number.isFinite(Date.parse(record.verifiedAt))
  );
}

/**
 * Reads the trusted-digest record for one version. Returns `undefined` when
 * the record is missing, malformed, bound to a different version/asset, or
 * (on POSIX) group/other-accessible — all of which fail closed.
 */
async function readTrustRecord(
  cacheRoot: string,
  version: string,
  asset: string,
): Promise<TrustedBinaryRecord | undefined> {
  try {
    const path = trustedRecordPath(cacheRoot, version);
    if (process.platform !== "win32") {
      const mode = (await stat(path)).mode;
      if ((mode & 0o077) !== 0) return undefined;
    }
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isTrustedBinaryRecord(parsed, version, asset) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeTrustRecord(
  cacheRoot: string,
  version: string,
  record: Omit<TrustedBinaryRecord, "verifiedAt">,
): Promise<void> {
  const path = trustedRecordPath(cacheRoot, version);
  const directory = join(cacheRoot, version);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(
    { ...record, verifiedAt: new Date().toISOString() },
    null,
    2,
  )}\n`;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
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

/**
 * Ensures the requested version exists in the cache and is verified:
 *   1. A previously written trusted-digest record authorizes the cached
 *      binary without network access (offline reuse).
 *   2. Otherwise a cached binary is checked against the release manifest;
 *      when the manifest is unreachable the binary is REJECTED — an
 *      unverified cached executable must never run merely because it exists.
 *   3. A verified download writes both the binary and the trust record.
 */
async function ensureVersion(
  fetchImplementation: typeof fetch,
  cacheRoot: string,
  version: string,
): Promise<string> {
  const asset = assetFor();
  const targetPath = binaryPath(cacheRoot, version);

  // Offline-safe fast path: a previously verified digest is the trust anchor.
  const trusted = await readTrustRecord(cacheRoot, version, asset);
  if (trusted) {
    try {
      if ((await sha256File(targetPath)) === trusted.sha256) {
        return targetPath;
      }
    } catch {
      // Binary missing or unreadable; fall through to a fresh fetch.
    }
  }

  let cached = "";
  try {
    cached = await sha256File(targetPath);
  } catch {
    // Not cached yet.
  }

  if (cached) {
    let expected = "";
    try {
      expected = await manifestDigest(fetchImplementation, version, asset);
    } catch (error) {
      // Fail closed: no matching trusted digest, and no manifest to verify
      // against. Refusing to run beats running an unverified binary.
      throw new Error(
        `omp v${version} is cached but cannot be verified (${error instanceof Error ? error.message : String(error)}). ` +
          "Refusing to execute an unverified cached omp binary; restore network access or pin an explicit digest.",
      );
    }
    if (cached === expected) {
      await writeTrustRecord(cacheRoot, version, {
        version,
        asset,
        sha256: cached,
        verifiedFrom: "release-manifest",
      });
      return targetPath;
    }
    await rm(targetPath, { force: true });
  }

  let verifiedWrite = false;
  try {
    await mkdir(join(cacheRoot, version), { recursive: true, mode: 0o700 });
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
    verifiedWrite = true;
    await writeTrustRecord(cacheRoot, version, {
      version,
      asset,
      sha256: actual,
      verifiedFrom: "release-manifest",
    });
    return targetPath;
  } catch (error) {
    // Only a binary verified earlier in this run may be reused; anything else
    // (mismatch, interrupted download) must not resurrect an unverified file.
    if (verifiedWrite) return targetPath;
    throw error;
  }
}

/**
 * Resolves exactly one pinned version. The policy digest, when provided, is
 * itself a trust anchor: a cache entry matching it executes without network
 * access, and any resolved binary must match it.
 */
async function resolvePinned(
  fetchImplementation: typeof fetch,
  cacheRoot: string,
  version: string,
  digest?: string,
): Promise<string> {
  const asset = assetFor();
  const targetPath = binaryPath(cacheRoot, version);
  if (digest) {
    try {
      if ((await sha256File(targetPath)) === digest) {
        await writeTrustRecord(cacheRoot, version, {
          version,
          asset,
          sha256: digest,
          verifiedFrom: "policy",
        });
        return targetPath;
      }
    } catch {
      // Not cached or digest mismatch; verify/fetch below.
    }
  }
  const ensured = await ensureVersion(fetchImplementation, cacheRoot, version);
  if (digest) {
    const actual = await sha256File(ensured);
    if (actual !== digest) {
      throw new Error(
        `omp binary SHA-256 mismatch for pinned v${version}: expected ${digest}, got ${actual}.`,
      );
    }
  }
  return ensured;
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
 * Resolves the omp RPC binary according to the version policy:
 *   1. `OMP_BINARY` env override wins (operator-supplied trust).
 *   2. `pinned` policy: exactly one version, SHA-256-anchored when a digest
 *      is given; never checks for or applies updates. Benchmarks MUST use
 *      this mode so no benchmark run silently changes the omp core.
 *   3. `managed` / `development-latest` (and the default): the pinned version
 *      is ensured, then the latest omp release is checked (GitHub API,
 *      TTL-cached) and applied when newer. Failures fall back to the current
 *      verified binary; disable checks with LHIC_DISABLE_OMP_UPDATE=1.
 * Every downloaded or reused binary is SHA-256 verified against the release
 * manifest or a previously trusted digest record; unverified binaries never
 * execute.
 */
export async function resolveOmpBinary(
  options: OmpUpdaterOptions = {},
): Promise<string> {
  if (process.env.OMP_BINARY) {
    return process.env.OMP_BINARY;
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const cacheRoot = cacheRootFor(options);
  const policy = options.policy ?? { mode: "managed" };

  if (policy.mode === "pinned") {
    // The packaged binary is the pin itself; nothing to verify or update.
    if (options.bundledBinary) return options.bundledBinary;
    return resolvePinned(
      fetchImplementation,
      cacheRoot,
      policy.version,
      policy.digest,
    );
  }

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
