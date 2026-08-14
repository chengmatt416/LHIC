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
const sha256Pattern = /^[a-f0-9]{64}$/;

const assetForPlatform: Record<string, Record<string, string>> = {
  darwin: { arm64: "omp-darwin-arm64", x64: "omp-darwin-x64" },
  linux: { arm64: "omp-linux-arm64", x64: "omp-linux-x64" },
  win32: { x64: "omp-windows-x64.exe" },
};

/**
 * Trust mode for an `OMP_BINARY` override when no digest is available to
 * verify it against.
 * - `explicit-operator`: an operator deliberately chose this executable.
 * - `digest-required`: never accept the override without a matching digest.
 * - `development-only`: local development escape hatch.
 * A bare `OMP_BINARY` without a digest and without one of these modes is
 * rejected (production and benchmark paths must not run unverified code).
 */
export type OmpBinaryTrustMode =
  "explicit-operator" | "digest-required" | "development-only";

/**
 * Result of resolving the omp RPC binary. Every execution source — cache,
 * download, bundled packaging, or explicit override — produces an identity:
 * the verified SHA-256 and the version it corresponds to, plus how that
 * identity was established.
 */
export interface VerifiedOmpBinary {
  path: string;
  version: string;
  sha256: string;
  trustSource:
    | "explicit-digest"
    | "explicit-operator"
    | "trusted-record"
    | "release-manifest";
}

/**
 * Immutable local record of a successfully verified omp binary. Written once
 * a release manifest (or an explicit policy digest) has been matched against
 * the actual cached bytes; consulted when the network is unavailable so that
 * only previously trusted binaries run offline. A record never rotates to a
 * different digest for the same version without an explicit administrative
 * pin.
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
 *   anchor and works offline). Every pinned source — cache, download,
 *   bundled binary, or `OMP_BINARY` override — must satisfy the digest.
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
  /**
   * Pre-resolved binary for the pinned version (e.g. the packaged app).
   * In pinned mode the bundled binary must match the pinned digest; its
   * version identity is validated against the policy when
   * `bundledBinaryVersion` is provided.
   */
  bundledBinary?: string;
  /** Version identity of the bundled binary (measured at build time). */
  bundledBinaryVersion?: string;
  /**
   * Version policy. Defaults to `{ mode: "managed" }`, which preserves the
   * historical auto-update behavior. Benchmark and release paths MUST use
   * `{ mode: "pinned" }` so runs never silently change the omp core.
   */
  policy?: OmpVersionPolicy;
}

interface OmpBinaryOverride {
  path: string;
  digest?: string;
  version?: string;
  trustMode?: OmpBinaryTrustMode;
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
    sha256Pattern.test(record.sha256) &&
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

/**
 * Writes a trusted-digest record. A record for the same version with a
 * different digest is rejected unless the write is an explicit
 * administrative pin (policy digest); release-manifest verification can never
 * silently rotate a version's digest.
 */
async function writeTrustRecord(
  cacheRoot: string,
  version: string,
  record: Omit<TrustedBinaryRecord, "verifiedAt">,
  options: { allowRotation: boolean },
): Promise<void> {
  const path = trustedRecordPath(cacheRoot, version);
  const directory = join(cacheRoot, version);
  const existing = await readTrustRecord(cacheRoot, version, record.asset);
  if (existing && existing.sha256 !== record.sha256 && !options.allowRotation) {
    throw new Error(
      `Refusing to rotate the trusted digest for omp v${version} from ${existing.sha256} to ${record.sha256}; rotation requires an explicit pinned digest.`,
    );
  }
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
  if (!sha256Pattern.test(digest)) {
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
 * `skipTrustedFastPath` forces manifest verification (used when a pinned
 * digest conflicts with the recorded digest, e.g. after a release
 * republish).
 */
async function ensureVersion(
  fetchImplementation: typeof fetch,
  cacheRoot: string,
  version: string,
  skipTrustedFastPath = false,
): Promise<VerifiedOmpBinary> {
  const asset = assetFor();
  const targetPath = binaryPath(cacheRoot, version);

  if (!skipTrustedFastPath) {
    // Offline-safe fast path: a previously verified digest is the trust anchor.
    const trusted = await readTrustRecord(cacheRoot, version, asset);
    if (trusted) {
      try {
        if ((await sha256File(targetPath)) === trusted.sha256) {
          return {
            path: targetPath,
            version,
            sha256: trusted.sha256,
            trustSource: "trusted-record",
          };
        }
      } catch {
        // Binary missing or unreadable; fall through to a fresh fetch.
      }
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
      await writeTrustRecord(
        cacheRoot,
        version,
        { version, asset, sha256: cached, verifiedFrom: "release-manifest" },
        { allowRotation: false },
      ).catch(() => undefined);
      return {
        path: targetPath,
        version,
        sha256: cached,
        trustSource: "release-manifest",
      };
    }
    await rm(targetPath, { force: true });
  }

  let verifiedWrite = false;
  let verifiedSha = "";
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
    verifiedSha = actual;
    await writeFile(targetPath, bytes);
    if (process.platform !== "win32") {
      await chmod(targetPath, 0o755);
    }
    verifiedWrite = true;
    await writeTrustRecord(
      cacheRoot,
      version,
      { version, asset, sha256: actual, verifiedFrom: "release-manifest" },
      { allowRotation: false },
    ).catch(() => undefined);
    return {
      path: targetPath,
      version,
      sha256: actual,
      trustSource: "release-manifest",
    };
  } catch (error) {
    // Only a binary verified earlier in this run may be reused; anything else
    // (mismatch, interrupted download) must not resurrect an unverified file.
    if (verifiedWrite) {
      return {
        path: targetPath,
        version,
        sha256: verifiedSha,
        trustSource: "release-manifest",
      };
    }
    throw error;
  }
}

/**
 * Resolves exactly one pinned version. Every source flows through digest
 * verification: the policy digest anchors cached bytes (offline-capable),
 * the release manifest verifies downloads, and a bundled binary must match
 * the pin. Version identity conflicts fail.
 */
async function resolvePinned(
  fetchImplementation: typeof fetch,
  cacheRoot: string,
  policy: { mode: "pinned"; version: string; digest?: string },
  options: OmpUpdaterOptions,
): Promise<VerifiedOmpBinary> {
  const { version, digest } = policy;
  if (options.bundledBinary) {
    if (
      options.bundledBinaryVersion &&
      options.bundledBinaryVersion !== version
    ) {
      throw new Error(
        `Bundled omp version ${options.bundledBinaryVersion} does not match pinned version ${version}.`,
      );
    }
    let sha256 = "";
    try {
      sha256 = await sha256File(options.bundledBinary);
    } catch {
      throw new Error(
        `Bundled omp binary ${options.bundledBinary} does not exist or is unreadable.`,
      );
    }
    if (!digest) {
      throw new Error(
        `Pinned omp policy requires a digest to verify the bundled binary ${options.bundledBinary}; pin a digest for v${version}.`,
      );
    }
    if (sha256 !== digest) {
      throw new Error(
        `Bundled omp binary SHA-256 mismatch for pinned v${version}: expected ${digest}, got ${sha256}.`,
      );
    }
    return {
      path: options.bundledBinary,
      version,
      sha256,
      trustSource: "explicit-digest",
    };
  }
  const asset = assetFor();
  const targetPath = binaryPath(cacheRoot, version);
  if (digest) {
    try {
      if ((await sha256File(targetPath)) === digest) {
        await writeTrustRecord(
          cacheRoot,
          version,
          { version, asset, sha256: digest, verifiedFrom: "policy" },
          { allowRotation: true },
        );
        return {
          path: targetPath,
          version,
          sha256: digest,
          trustSource: "explicit-digest",
        };
      }
    } catch {
      // Not cached or digest mismatch; verify/fetch below.
    }
  }
  const ensured = await ensureVersion(
    fetchImplementation,
    cacheRoot,
    version,
    digest !== undefined,
  );
  if (digest) {
    const actual = await sha256File(ensured.path);
    if (actual !== digest) {
      throw new Error(
        `omp binary SHA-256 mismatch for pinned v${version}: expected ${digest}, got ${actual}.`,
      );
    }
    return { ...ensured, version, trustSource: "explicit-digest" };
  }
  return { ...ensured, version };
}

/**
 * Verifies an `OMP_BINARY` override. The override path must exist; its
 * identity (SHA-256) is always measured. The expected digest is the pinned
 * policy digest when pinned, otherwise `OMP_BINARY_DIGEST`. Without any
 * digest, the override is rejected unless an explicit trust mode
 * (`OMP_BINARY_TRUST`) authorizes it, and a pinned policy always requires a
 * digest.
 */
async function resolveOverride(
  override: OmpBinaryOverride,
  policy: OmpVersionPolicy,
): Promise<VerifiedOmpBinary> {
  let sha256 = "";
  try {
    sha256 = await sha256File(override.path);
  } catch {
    throw new Error(
      `OMP_BINARY override ${override.path} does not exist or is unreadable; refusing to run an unverified omp binary.`,
    );
  }
  const pinnedVersion = policy.mode === "pinned" ? policy.version : undefined;
  if (pinnedVersion && override.version && override.version !== pinnedVersion) {
    throw new Error(
      `OMP_BINARY version ${override.version} does not match pinned version ${pinnedVersion}.`,
    );
  }
  const expectedDigest =
    policy.mode === "pinned"
      ? (policy.digest ?? override.digest)
      : override.digest;
  if (expectedDigest) {
    if (sha256 !== expectedDigest) {
      throw new Error(
        `OMP_BINARY SHA-256 mismatch: expected ${expectedDigest}, got ${sha256} for ${override.path}.`,
      );
    }
    return {
      path: override.path,
      version: pinnedVersion ?? override.version ?? "unknown",
      sha256,
      trustSource: "explicit-digest",
    };
  }
  if (policy.mode === "pinned") {
    throw new Error(
      `Pinned omp policy requires a digest for OMP_BINARY override ${override.path}; set OMP_BINARY_DIGEST or pin a digest.`,
    );
  }
  if (
    override.trustMode !== "explicit-operator" &&
    override.trustMode !== "development-only"
  ) {
    throw new Error(
      `OMP_BINARY override ${override.path} is unverified; set OMP_BINARY_DIGEST=<sha256> or OMP_BINARY_TRUST=explicit-operator|development-only to authorize it.`,
    );
  }
  return {
    path: override.path,
    version: override.version ?? "unknown",
    sha256,
    trustSource: "explicit-operator",
  };
}

function readBinaryOverride(): OmpBinaryOverride | undefined {
  const path = process.env.OMP_BINARY;
  if (!path || path.length === 0) return undefined;
  const digest = process.env.OMP_BINARY_DIGEST;
  const version = process.env.OMP_BINARY_VERSION;
  const rawTrust = process.env.OMP_BINARY_TRUST;
  const trustMode: OmpBinaryTrustMode | undefined =
    rawTrust === "explicit-operator" ||
    rawTrust === "digest-required" ||
    rawTrust === "development-only"
      ? rawTrust
      : undefined;
  return {
    path,
    ...(digest && sha256Pattern.test(digest) ? { digest } : {}),
    ...(version && version.length > 0 ? { version } : {}),
    ...(trustMode ? { trustMode } : {}),
  };
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
 * Resolves the omp RPC binary with a verified identity:
 *   1. `OMP_BINARY` override: identity measured and checked against the
 *      pinned digest or `OMP_BINARY_DIGEST`; unverified overrides are
 *      rejected unless an explicit trust mode authorizes them. A pinned
 *      policy always requires a digest.
 *   2. `pinned` policy: exactly one version; the policy digest anchors
 *      cached bytes, bundled binaries, and overrides alike. Never checks
 *      for or applies updates. Benchmarks MUST use this mode.
 *   3. `managed` / `development-latest` (and the default): the pinned
 *      version is ensured, then the latest omp release is checked (GitHub
 *      API, TTL-cached) and applied when newer. Failures fall back to the
 *      current verified binary; disable checks with LHIC_DISABLE_OMP_UPDATE=1.
 * Every returned binary carries its measured SHA-256 and version identity;
 * unverified binaries never execute.
 */
export async function resolveOmpBinary(
  options: OmpUpdaterOptions = {},
): Promise<VerifiedOmpBinary> {
  const policy = options.policy ?? { mode: "managed" };
  const override = readBinaryOverride();
  if (override) {
    return resolveOverride(override, policy);
  }
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const cacheRoot = cacheRootFor(options);

  if (policy.mode === "pinned") {
    return resolvePinned(fetchImplementation, cacheRoot, policy, options);
  }

  const pinned = pinnedVersionFor(options);
  if (options.bundledBinary) {
    let sha256 = "";
    try {
      sha256 = await sha256File(options.bundledBinary);
    } catch {
      throw new Error(
        `Bundled omp binary ${options.bundledBinary} does not exist or is unreadable.`,
      );
    }
    return {
      path: options.bundledBinary,
      version: pinned,
      sha256,
      trustSource: "release-manifest",
    };
  }
  const current = await ensureVersion(fetchImplementation, cacheRoot, pinned);
  const updateCheckEnabled =
    options.updateCheckEnabled ?? process.env.LHIC_DISABLE_OMP_UPDATE !== "1";
  if (!updateCheckEnabled) {
    return current;
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
      return updated;
    } catch {
      // Fall through to the current binary.
    }
  }
  return current;
}
