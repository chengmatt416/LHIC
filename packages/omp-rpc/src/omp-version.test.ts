import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    await rm(directory, { recursive: true, force: true });
  });

  it("compares semantic versions", () => {
    expect(isNewerOmpVersion("17.3.0", "17.2.15")).toBe(true);
    expect(isNewerOmpVersion("17.2.15", "17.2.15")).toBe(false);
    expect(isNewerOmpVersion("18.0.0", "17.9.9")).toBe(true);
    expect(isNewerOmpVersion("17.2.15", "18.0.0")).toBe(false);
    expect(isNewerOmpVersion("v17.3.0", "17.2.15")).toBe(true);
  });

  it("honors the OMP_BINARY override", async () => {
    process.env.OMP_BINARY = "/tmp/omp-custom";
    await expect(resolveOmpBinary({ cacheRoot: directory })).resolves.toBe(
      "/tmp/omp-custom",
    );
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
      resolver.endsWith(
        join("17.3.0", platform === "win32" ? "omp.exe" : "omp"),
      ),
    ).toBe(true);
    const resolvedBytes = await readFile(resolver);
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
    expect(resolver.endsWith(join("17.2.15", "omp"))).toBe(true);
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
    expect(resolver.endsWith(join("17.2.15", binaryName))).toBe(true);
    expect(Buffer.from(await readFile(resolver)).toString()).toBe(
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
    await writeFile(
      join(directory, "17.3.0", binaryName),
      Buffer.from(bytes),
    );
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
    expect(resolver.endsWith(join("17.2.15", binaryName))).toBe(true);
    expect(Buffer.from(await readFile(resolver)).toString()).toBe(
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
    expect(resolver.endsWith(join("17.2.15", binaryName))).toBe(true);
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
});
