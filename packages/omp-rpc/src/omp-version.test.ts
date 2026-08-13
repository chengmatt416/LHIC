import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isNewerOmpVersion, resolveOmpBinary } from "./omp-version.js";

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
});
