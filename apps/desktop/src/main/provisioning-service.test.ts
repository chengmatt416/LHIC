import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { execFile } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProvisioningService } from "./provisioning-service.js";

function fakeExecFile(
  handler: (
    file: string,
    args: string[],
  ) => { stdout?: string; stderr?: string; code?: number } = () => ({}),
) {
  return ((
    file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const response = handler(file, args);
    const code = response.code ?? 0;
    if (code !== 0) {
      const error = new Error(`exit ${code}`) as Error & { code?: unknown };
      error.code = code;
      callback(error, "", response.stderr ?? "");
      return;
    }
    callback(null, response.stdout ?? "", response.stderr ?? "");
  }) as unknown as typeof execFile;
}

describe("ProvisioningService", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "lhic-provision-"));
  });

  afterEach(async () => {
    delete process.env.LHIC_SKIP_BACKENDS;
    await rm(directory, { recursive: true, force: true });
  });

  it("skips everything when LHIC_SKIP_BACKENDS=1", async () => {
    process.env.LHIC_SKIP_BACKENDS = "1";
    const calls: string[] = [];
    const service = new ProvisioningService({
      userDataDir: directory,
      execFileImplementation: fakeExecFile((file) => {
        calls.push(file);
        return {};
      }),
    });
    const report = await service.ensureProvisioned();
    expect(report[0]?.message).toContain("LHIC_SKIP_BACKENDS=1");
    expect(calls).toEqual([]);
  });

  it("runs only once and records the marker", async () => {
    const calls: string[] = [];
    const service = new ProvisioningService({
      userDataDir: directory,
      executionSourceDir: join(directory, "execution"),
      execFileImplementation: fakeExecFile((file) => {
        calls.push(file);
        return {};
      }),
    });
    await service.ensureProvisioned();
    const second = await service.ensureProvisioned();
    expect(second).toBe(await service.ensureProvisioned());
    const { stat } = await import("node:fs/promises");
    await expect(
      stat(join(directory, "provisioned.json")),
    ).resolves.toBeDefined();
    expect(calls.filter((file) => file === "python3").length).toBe(2); // import check + no install
  });

  it("provisions OmniParser with the pip ladder and Chromium on Linux", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const service = new ProvisioningService({
      userDataDir: directory,
      execFileImplementation: fakeExecFile((file, args) => {
        calls.push({ file, args });
        if (file === "python3" && args[0] === "-c") {
          return { code: 1, stderr: "ModuleNotFoundError" };
        }
        if (file === "python3" && args[0] === "-m") {
          return { code: 1, stderr: "error: externally-managed-environment" };
        }
        return {};
      }),
    });
    const report = await service.ensureProvisioned();
    const omniparserSteps = report.filter((step) => step.name === "omniparser");
    expect(
      omniparserSteps.some((step) => step.message.includes("pip ladder")),
    ).toBe(true);
    expect(omniparserSteps.at(-1)?.message.includes("install failed")).toBe(
      true,
    );
    const pipCalls = calls.filter(
      (call) => call.file === "python3" && call.args[0] === "-m",
    );
    expect(pipCalls).toHaveLength(3); // --user → --user --break-system-packages → system
    expect(
      pipCalls.some((call) => call.args.includes("--break-system-packages")),
    ).toBe(true);
    expect(calls.some((call) => call.file === "npx")).toBe(true);
  });

  it("reports OmniParser installed only when the import verification passes", async () => {
    let pipAttempts = 0;
    let installed = false;
    const calls: Array<{ file: string; args: string[] }> = [];
    const service = new ProvisioningService({
      userDataDir: directory,
      execFileImplementation: fakeExecFile((file, args) => {
        calls.push({ file, args });
        if (file === "python3" && args[0] === "-c") {
          return installed
            ? { code: 0, stdout: "ok" }
            : { code: 1, stderr: "ModuleNotFoundError" };
        }
        if (file === "python3" && args[0] === "-m") {
          pipAttempts += 1;
          if (pipAttempts === 2) {
            installed = true;
            return { code: 0 };
          }
          return { code: 1, stderr: "error: externally-managed-environment" };
        }
        if (file === "npx") return {};
        return { code: 0 }; // --version probes succeed
      }),
    });
    const report = await service.ensureProvisioned();
    const omniparserSteps = report.filter((step) => step.name === "omniparser");
    expect(
      omniparserSteps.some((step) =>
        step.message.includes("installed (weights"),
      ),
    ).toBe(true);
    expect(pipAttempts).toBe(2);
  });

  it("skips Peekaboo on macOS below 15", async () => {
    // Cannot change process.platform in-process; drive the branch through the
    // sw_vers response while the platform gate is bypassed by direct call.
    const calls: string[] = [];
    const service = new ProvisioningService({
      userDataDir: directory,
      execFileImplementation: fakeExecFile((file) => {
        calls.push(file);
        if (file === "sw_vers") return { stdout: "14.6.1\n" };
        return { code: 1 };
      }),
    });
    // Force the macOS decision path by running the step directly.
    const report: Array<{ name: string; message: string }> = [];
    await service["provisionPeekaboo"](report);
    const peekaboo = report[0];
    expect(peekaboo?.name).toBe("peekaboo");
    expect(peekaboo?.message).toContain("macOS 15");
    expect(calls.some((file) => file === "brew" || file === "npm")).toBe(false);
  });

  it("builds the FlaUI bridge when dotnet is present on Windows", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const service = new ProvisioningService({
      userDataDir: directory,
      executionSourceDir: join(directory, "execution"),
      execFileImplementation: fakeExecFile((file, args) => {
        calls.push({ file, args });
        if (file === "powershell") {
          return { stdout: "10.0.19045.0\n" };
        }
        if (file === "dotnet") return {};
        return { code: 1 };
      }),
    });
    const report: Array<{ name: string; message: string }> = [];
    await service["provisionFlaUI"](report);
    const flaui = report[0];
    expect(flaui?.name).toBe("flaui");
    expect(
      calls.some(
        (call) => call.file === "dotnet" && call.args[0] === "publish",
      ),
    ).toBe(true);
  });

  it("skips the FlaUI bridge below Windows 10 1607", async () => {
    const calls: string[] = [];
    const service = new ProvisioningService({
      userDataDir: directory,
      executionSourceDir: join(directory, "execution"),
      execFileImplementation: fakeExecFile((file) => {
        calls.push(file);
        if (file === "powershell") return { stdout: "6.3.9600.0\n" };
        return {};
      }),
    });
    const report: Array<{ name: string; message: string }> = [];
    await service["provisionFlaUI"](report);
    expect(report[0]?.message).toContain("Windows 10 1607");
    expect(calls.some((file) => file === "dotnet")).toBe(false);
  });
});
