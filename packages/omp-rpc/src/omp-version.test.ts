import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isNewerOmpVersion,
  resolveOmpBinary,
  type TrustedBinaryRecord,
} from "./omp-version.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const platform = process.platform;
const arch = process.arch;
const assetForPlatform: Record<string, Record<string, string>> = {
  darwin: { arm64: "omp-darwin-arm64", x64: "omp-darwin-x64" },
  linux: { arm64: "omp-linux-arm64", x64: "omp-linux-x64" },
  win32: { x64: "omp-windows-x64.exe" },
};
const asset = assetForPlatform[platform]?.[arch] ?? "omp";
const binaryName = platform === "win32" ? "omp.exe" : "omp";

function offlineFetch(): typeof fetch {
  return async () => {
    throw new Error("network unavailable");
  };
}

function mockFetch(binaries: Record<string, Uint8Array>, apiCalls: string[]) {
  return async (url: string) => {
    if (url.includes("api.github.com")) {
      apiCalls.push(url);
      return {
        ok: true,
        json: async () => ({ tag_name: "v17.3.0" }),
      } as Response;
    }
    if (url.endsWith("/SHA256SUMS.txt")) {
      const version = /download\/v([\d.]+)\//.exec(url)?.[1] ?? "";
      const bytes = binaries[version]!;
      return {
        ok: true,
        text: async () => `${sha256(bytes)}  ${asset}\n`,
      } as Response;
    }
    const version = /download\/v([\d.]+)\//.exec(url)?.[1] ?? "";
    return {
      ok: true,
      arrayBuffer: async () => binaries[version]!.buffer,
    } as Response;
  };
}

describe("omp version updater", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-omp-update-"));
  });

  afterEach(async () => {
    delete process.env.OMP_BINARY;
    delete process.env.OMP_BINARY_DIGEST;
    delete process.env.OMP_BINARY_VERSION;
    delete process.env.OMP_BINARY_TRUST;
    await rm(directory, { recursive: true, force: true });
  });

  it("compares semantic versions", () => {
    expect(isNewerOmpVersion("17.3.0", "17.2.15")).toBe(true);
    expect(isNewerOmpVersion("17.2.15", "17.2.15")).toBe(false);
    expect(isNewerOmpVersion("18.0.0", "17.9.9")).toBe(true);
    expect(isNewerOmpVersion("17.2.15", "18.0.0")).toBe(false);
    expect(isNewerOmpVersion("v17.3.0", "17.2.15")).toBe(true);
  });

  it("honors an OMP_BINARY override only with a trust mode or digest", async () => {
    const overridePath = join(directory, "custom-omp");
    const bytes = new TextEncoder().encode("custom-omp-bytes");
    await writeFile(overridePath, bytes);
    // Bare override (no digest, no trust mode) is rejected in production.
    process.env.OMP_BINARY = overridePath;
    await expect(resolveOmpBinary({ cacheRoot: directory })).rejects.toThrow(
      /is unverified/,
    );
    // An explicit development trust mode authorizes it and records identity.
    process.env.OMP_BINARY_TRUST = "development-only";
    const resolved = await resolveOmpBinary({ cacheRoot: directory });
    expect(resolved.path).toBe(overridePath);
    expect(resolved.sha256).toBe(sha256(bytes));
    expect(resolved.trustSource).toBe("explicit-operator");
  });

  it("auto-updates to the newest omp release with SHA-256 verification", async () => {
    const current = new TextEncoder().encode("omp-17.2.15-bytes");
    const latest = new TextEncoder().encode("omp-17.3.0-bytes");
    const apiCalls: string[] = [];
    const resolver = await resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 0,
      fetchImplementation: mockFetch(
        { "17.2.15": current, "17.3.0": latest },
        apiCalls,
      ) as typeof fetch,
    });
    expect(
      resolver.path.endsWith(
        join("17.3.0", platform === "win32" ? "omp.exe" : "omp"),
      ),
    ).toBe(true);
    const resolvedBytes = await readFile(resolver.path);
    expect(Buffer.from(resolvedBytes).toString()).toBe("omp-17.3.0-bytes");
    expect(apiCalls.length).toBe(1);
    const marker = JSON.parse(
      await readFile(join(directory, "latest.json"), "utf8"),
    ) as { version?: string };
    expect(marker.version).toBe("17.3.0");
  });

  it("caches the update check within the interval", async () => {
    const bytes = new TextEncoder().encode("omp-bytes");
    const apiCalls: string[] = [];
    const fetchImpl = mockFetch(
      { "17.2.15": bytes, "17.3.0": bytes },
      apiCalls,
    );
    const options = {
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 3_600_000,
      fetchImplementation: fetchImpl as typeof fetch,
    };
    await resolveOmpBinary(options);
    const first = apiCalls.length;
    await resolveOmpBinary(options);
    expect(apiCalls.length).toBe(first); // No second API call inside the TTL.
  });

  it("falls back to the current binary when the update check fails", async () => {
    const current = new TextEncoder().encode("omp-17.2.15-bytes");
    const failingFetch = async (url: string) => {
      if (url.includes("api.github.com")) {
        throw new Error("rate limited");
      }
      if (url.endsWith("/SHA256SUMS.txt")) {
        return {
          ok: true,
          text: async () => `${sha256(current)}  ${asset}\n`,
        } as Response;
      }
      return { ok: true, arrayBuffer: async () => current.buffer } as Response;
    };
    const resolver = await resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 0,
      fetchImplementation: failingFetch as typeof fetch,
    });
    expect(resolver.path.endsWith(join("17.2.15", "omp"))).toBe(true);
  });

  it("writes a permission-restricted trust record after verification", async () => {
    const bytes = new TextEncoder().encode("omp-17.2.15-bytes");
    await resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 3_600_000,
      updateCheckEnabled: false,
      fetchImplementation: mockFetch({ "17.2.15": bytes }, []) as typeof fetch,
    });
    const recordPath = join(directory, "17.2.15", "trusted.json");
    const record = JSON.parse(
      await readFile(recordPath, "utf8"),
    ) as TrustedBinaryRecord;
    expect(record.version).toBe("17.2.15");
    expect(record.asset).toBe(asset);
    expect(record.sha256).toBe(sha256(bytes));
    expect(record.verifiedFrom).toBe("release-manifest");
    expect(Number.isFinite(Date.parse(record.verifiedAt))).toBe(true);
    if (platform !== "win32") {
      const mode = (await stat(recordPath)).mode;
      expect(mode & 0o077).toBe(0); // Not group/other-accessible.
    }
  });

  it("reuses a previously verified cached binary offline", async () => {
    const bytes = new TextEncoder().encode("omp-17.2.15-bytes");
    await resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 3_600_000,
      updateCheckEnabled: false,
      fetchImplementation: mockFetch({ "17.2.15": bytes }, []) as typeof fetch,
    });
    const resolver = await resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      updateCheckEnabled: false,
      fetchImplementation: offlineFetch(),
    });
    expect(resolver.path.endsWith(join("17.2.15", binaryName))).toBe(true);
    expect(Buffer.from(await readFile(resolver.path)).toString()).toBe(
      "omp-17.2.15-bytes",
    );
  });

  it("fails closed offline when the cached binary is tampered", async () => {
    const bytes = new TextEncoder().encode("omp-17.2.15-bytes");
    await resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 3_600_000,
      updateCheckEnabled: false,
      fetchImplementation: mockFetch({ "17.2.15": bytes }, []) as typeof fetch,
    });
    await writeFile(
      join(directory, "17.2.15", binaryName),
      Buffer.concat([Buffer.from(bytes), new Uint8Array([0x00])]),
    );
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        pinnedVersion: "17.2.15",
        updateCheckEnabled: false,
        fetchImplementation: offlineFetch(),
      }),
    ).rejects.toThrow(/cached but cannot be verified/);
  });

  it("fails closed offline when the cache has no trust record", async () => {
    await mkdir(join(directory, "17.2.15"), { recursive: true });
    await writeFile(
      join(directory, "17.2.15", binaryName),
      "unverified-omp-bytes",
    );
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        pinnedVersion: "17.2.15",
        updateCheckEnabled: false,
        fetchImplementation: offlineFetch(),
      }),
    ).rejects.toThrow(/cached but cannot be verified/);
  });

  it("fails closed offline when no cache exists at all", async () => {
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        pinnedVersion: "17.2.15",
        updateCheckEnabled: false,
        fetchImplementation: offlineFetch(),
      }),
    ).rejects.toThrow(/network unavailable/);
  });

  it("rejects a trust record moved from another version", async () => {
    const bytes = new TextEncoder().encode("omp-17.2.15-bytes");
    await resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 3_600_000,
      updateCheckEnabled: false,
      fetchImplementation: mockFetch({ "17.2.15": bytes }, []) as typeof fetch,
    });
    // Plant a 17.3.0 cache carrying 17.2.15's trust record (version bound).
    await mkdir(join(directory, "17.3.0"), { recursive: true });
    await writeFile(join(directory, "17.3.0", binaryName), Buffer.from(bytes));
    await writeFile(
      join(directory, "17.3.0", "trusted.json"),
      await readFile(join(directory, "17.2.15", "trusted.json")),
    );
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        pinnedVersion: "17.3.0",
        updateCheckEnabled: false,
        fetchImplementation: offlineFetch(),
      }),
    ).rejects.toThrow(/cached but cannot be verified/);
  });

  it("pinned policy never checks for updates and uses exactly the pinned version", async () => {
    const current = new TextEncoder().encode("omp-17.2.15-bytes");
    const latest = new TextEncoder().encode("omp-17.3.0-bytes");
    const apiCalls: string[] = [];
    const resolver = await resolveOmpBinary({
      cacheRoot: directory,
      policy: { mode: "pinned", version: "17.2.15" },
      fetchImplementation: mockFetch(
        { "17.2.15": current, "17.3.0": latest },
        apiCalls,
      ) as typeof fetch,
    });
    expect(resolver.path.endsWith(join("17.2.15", binaryName))).toBe(true);
    expect(Buffer.from(await readFile(resolver.path)).toString()).toBe(
      "omp-17.2.15-bytes",
    );
    expect(apiCalls.length).toBe(0); // No latest-release check in pinned mode.
  });

  it("pinned policy with a matching digest runs offline from cache", async () => {
    const bytes = new TextEncoder().encode("omp-17.2.15-bytes");
    await mkdir(join(directory, "17.2.15"), { recursive: true });
    await writeFile(join(directory, "17.2.15", binaryName), bytes);
    const resolver = await resolveOmpBinary({
      cacheRoot: directory,
      policy: { mode: "pinned", version: "17.2.15", digest: sha256(bytes) },
      fetchImplementation: offlineFetch(),
    });
    expect(resolver.path.endsWith(join("17.2.15", binaryName))).toBe(true);
    const record = JSON.parse(
      await readFile(join(directory, "17.2.15", "trusted.json"), "utf8"),
    ) as TrustedBinaryRecord;
    expect(record.verifiedFrom).toBe("policy");
    expect(record.sha256).toBe(sha256(bytes));
  });

  it("pinned policy with a mismatched digest fails closed", async () => {
    const current = new TextEncoder().encode("omp-17.2.15-bytes");
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        policy: {
          mode: "pinned",
          version: "17.2.15",
          digest: "0".repeat(64),
        },
        fetchImplementation: mockFetch(
          { "17.2.15": current },
          [],
        ) as typeof fetch,
      }),
    ).rejects.toThrow(/SHA-256 mismatch for pinned v17\.2\.15/);
  });

  it("accepts an OMP_BINARY override matching the pinned digest", async () => {
    const bytes = new TextEncoder().encode("override-omp-bytes");
    const overridePath = join(directory, "override-omp");
    await writeFile(overridePath, bytes);
    process.env.OMP_BINARY = overridePath;
    const resolved = await resolveOmpBinary({
      cacheRoot: directory,
      policy: { mode: "pinned", version: "17.2.15", digest: sha256(bytes) },
      fetchImplementation: offlineFetch(),
    });
    expect(resolved.path).toBe(overridePath);
    expect(resolved.trustSource).toBe("explicit-digest");
    expect(resolved.version).toBe("17.2.15");
  });

  it("rejects an OMP_BINARY override with a wrong digest", async () => {
    const bytes = new TextEncoder().encode("override-omp-bytes");
    const overridePath = join(directory, "override-omp");
    await writeFile(overridePath, bytes);
    process.env.OMP_BINARY = overridePath;
    process.env.OMP_BINARY_DIGEST = "1".repeat(64);
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        policy: { mode: "pinned", version: "17.2.15", digest: "2".repeat(64) },
      }),
    ).rejects.toThrow(/OMP_BINARY SHA-256 mismatch/);
  });

  it("rejects an OMP_BINARY override under a pinned policy without a digest", async () => {
    const overridePath = join(directory, "override-omp");
    await writeFile(overridePath, "override-omp-bytes");
    process.env.OMP_BINARY = overridePath;
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        policy: { mode: "pinned", version: "17.2.15" },
      }),
    ).rejects.toThrow(/requires a digest for OMP_BINARY override/);
  });

  it("rejects an OMP_BINARY override whose version conflicts with the pin", async () => {
    const overridePath = join(directory, "override-omp");
    await writeFile(overridePath, "override-omp-bytes");
    process.env.OMP_BINARY = overridePath;
    process.env.OMP_BINARY_VERSION = "18.0.0";
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        policy: { mode: "pinned", version: "17.2.15" },
      }),
    ).rejects.toThrow(/does not match pinned version 17\.2\.15/);
  });

  it("verifies a bundled binary against the pinned digest", async () => {
    const bytes = new TextEncoder().encode("bundled-omp-bytes");
    const bundled = join(directory, "bundled-omp");
    await writeFile(bundled, bytes);
    const options = {
      cacheRoot: directory,
      bundledBinary: bundled,
      bundledBinaryVersion: "17.2.15",
      policy: {
        mode: "pinned" as const,
        version: "17.2.15",
        digest: sha256(bytes),
      },
    };
    const resolved = await resolveOmpBinary(options);
    expect(resolved.path).toBe(bundled);
    expect(resolved.trustSource).toBe("explicit-digest");
    // Wrong digest fails.
    await expect(
      resolveOmpBinary({
        ...options,
        policy: { mode: "pinned", version: "17.2.15", digest: "3".repeat(64) },
      }),
    ).rejects.toThrow(/Bundled omp binary SHA-256 mismatch/);
    // No digest fails: a pinned bundled binary must have a verified identity.
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        bundledBinary: bundled,
        policy: { mode: "pinned", version: "17.2.15" },
      }),
    ).rejects.toThrow(/requires a digest to verify the bundled binary/);
    // Version mismatch fails.
    await expect(
      resolveOmpBinary({
        ...options,
        bundledBinaryVersion: "18.0.0",
      }),
    ).rejects.toThrow(/does not match pinned version 17\.2\.15/);
  });

  it("never silently rotates a version's trusted digest", async () => {
    const original = new TextEncoder().encode("original-omp-bytes");
    const republished = new TextEncoder().encode("republished-omp-bytes");
    await mkdir(join(directory, "17.2.15"), { recursive: true });
    // The cache now holds the republished bytes while the trust record is
    // still anchored to the originally verified digest.
    await writeFile(join(directory, "17.2.15", binaryName), republished);
    await writeFile(
      join(directory, "17.2.15", "trusted.json"),
      `${JSON.stringify(
        {
          version: "17.2.15",
          asset,
          sha256: sha256(original),
          verifiedFrom: "release-manifest",
          verifiedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    // The manifest serves the republished binary. The resolver verifies the
    // download but the record must stay anchored to the original digest.
    const resolving = resolveOmpBinary({
      cacheRoot: directory,
      pinnedVersion: "17.2.15",
      checkIntervalMs: 3_600_000,
      updateCheckEnabled: false,
      fetchImplementation: mockFetch(
        { "17.2.15": republished },
        [],
      ) as typeof fetch,
    });
    const resolved = await resolving;
    expect(resolved.path.endsWith(join("17.2.15", binaryName))).toBe(true);
    expect(resolved.sha256).toBe(sha256(republished));
    const record = JSON.parse(
      await readFile(join(directory, "17.2.15", "trusted.json"), "utf8"),
    ) as TrustedBinaryRecord;
    expect(record.sha256).toBe(sha256(original)); // Not rotated.
    // Offline after the republish: no trust match, no manifest -> fail closed.
    await expect(
      resolveOmpBinary({
        cacheRoot: directory,
        pinnedVersion: "17.2.15",
        updateCheckEnabled: false,
        fetchImplementation: offlineFetch(),
      }),
    ).rejects.toThrow(/cached but cannot be verified/);
  });

  it("rotates the trusted digest only through an explicit pinned digest", async () => {
    const original = new TextEncoder().encode("original-omp-bytes");
    const pinned = new TextEncoder().encode("pinned-omp-bytes");
    await mkdir(join(directory, "17.2.15"), { recursive: true });
    await writeFile(join(directory, "17.2.15", binaryName), original);
    await writeFile(
      join(directory, "17.2.15", "trusted.json"),
      `${JSON.stringify(
        {
          version: "17.2.15",
          asset,
          sha256: sha256(original),
          verifiedFrom: "release-manifest",
          verifiedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    // An explicit administrative pin (policy digest) is the rotation
    // authority: it replaces the record with the pinned digest.
    await writeFile(join(directory, "17.2.15", binaryName), pinned);
    const resolved = await resolveOmpBinary({
      cacheRoot: directory,
      policy: {
        mode: "pinned",
        version: "17.2.15",
        digest: sha256(pinned),
      },
      fetchImplementation: offlineFetch(),
    });
    expect(resolved.sha256).toBe(sha256(pinned));
    const record = JSON.parse(
      await readFile(join(directory, "17.2.15", "trusted.json"), "utf8"),
    ) as TrustedBinaryRecord;
    expect(record.sha256).toBe(sha256(pinned));
    expect(record.verifiedFrom).toBe("policy");
  });
});
