import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser } from "playwright";

import { parseRuntimeConfig, type EnvironmentSource } from "@lhic/security";

export interface PreflightCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PreflightReport {
  passed: boolean;
  checks: PreflightCheck[];
}

export async function runPreflight(
  environment: EnvironmentSource = process.env,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];

  // Node Version Check
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node-version",
    passed: Number.isInteger(nodeMajor) && nodeMajor >= 24,
    detail: `Node ${process.versions.node}; requires Node 24 or newer for node:sqlite.`,
  });

  // Non-root Execution Check
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  checks.push({
    name: "non-root-execution",
    passed: !isRoot,
    detail: isRoot
      ? "Running as ROOT user. This is a severe security risk in production."
      : "Running as a secure non-root user.",
  });

  // DNS Integrity Check
  try {
    const dns = await import("node:dns/promises");
    const ips = await dns.resolve4("github.com");
    const isHijacked = ips.some(
      (ip) => ip.startsWith("127.") || ip === "0.0.0.0",
    );
    checks.push({
      name: "dns-integrity",
      passed: !isHijacked,
      detail: isHijacked
        ? "DNS Resolution hijacked (resolved github.com to local loopback)."
        : `DNS Integrity check passed; github.com resolved to ${ips.join(", ")}`,
    });
  } catch (error) {
    checks.push({
      name: "dns-integrity",
      passed: false,
      detail: `DNS Resolution failed: ${(error as Error).message}`,
    });
  }

  // Runtime Configuration Check
  let traceDirectory: string | undefined;
  try {
    const config = parseRuntimeConfig(environment);
    traceDirectory = resolve(config.traceDirectory);
    await mkdir(traceDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(traceDirectory, 0o700);
    }
    checks.push({
      name: "runtime-configuration",
      passed: true,
      detail: `${config.environment} configuration accepted; ${config.allowedOrigins.length} allowed origins.`,
    });
  } catch (error) {
    checks.push({
      name: "runtime-configuration",
      passed: false,
      detail:
        error instanceof Error
          ? error.message
          : "Runtime configuration is invalid.",
    });
  }

  // Trace Storage Writable Check
  if (traceDirectory) {
    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(join(traceDirectory, "preflight-"));
      await writeFile(join(temporaryDirectory, "write-check"), "ok", {
        encoding: "utf8",
        mode: 0o600,
      });
      checks.push({
        name: "trace-storage",
        passed: true,
        detail: `Trace directory is writable: ${traceDirectory}`,
      });
    } catch (error) {
      checks.push({
        name: "trace-storage",
        passed: false,
        detail:
          error instanceof Error
            ? error.message
            : "Trace directory is not writable.",
      });
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }

  // Chromium Launch Check
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    checks.push({
      name: "chromium",
      passed: true,
      detail: "Playwright Chromium launched successfully.",
    });
  } catch (error) {
    checks.push({
      name: "chromium",
      passed: false,
      detail:
        error instanceof Error
          ? error.message
          : "Playwright Chromium could not launch.",
    });
  } finally {
    await browser?.close();
  }

  return { passed: checks.every((check) => check.passed), checks };
}

export async function runSystemPreflight(): Promise<PreflightReport> {
  return runPreflight({ ...process.env, LHIC_TRACE_DIRECTORY: tmpdir() });
}
