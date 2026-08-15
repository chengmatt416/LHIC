import { existsSync } from "node:fs";

import type { LhicHostCapabilities } from "@lhic/schema";
import {
  executionBackendOptionsFromEnvironment,
  resolveExecutionChain,
} from "@lhic/skills";
import { chromium } from "playwright";

const codingVerifierAdapters = [
  "command",
  "git_diff",
  "file_hash",
  "expected_content",
  "diagnostics",
];

/**
 * Resolves the machine-readable host capability manifest by probing, never
 * by assuming: an undetected browser/desktop backend stays unavailable.
 */
export async function resolveLhicHostCapabilities(): Promise<LhicHostCapabilities> {
  const browserAvailable = probeBrowser();
  const options = executionBackendOptionsFromEnvironment();
  let desktopBackends: string[] = [];
  let activeBackend: string | undefined;
  try {
    const chain = await resolveExecutionChain(options);
    if (chain.backend) {
      activeBackend = chain.backend.id;
      desktopBackends.push(chain.backend.id);
    }
    if (chain.omniparser) desktopBackends.push(chain.omniparser.id);
    desktopBackends.push("native");
  } catch {
    // Probe failure: report the native layer conservatively as the only
    // guaranteed fallback, not as a detected backend.
    desktopBackends = ["native"];
  }
  return {
    schemaVersion: "lhic-host-capabilities-v1",
    browser: {
      available: browserAvailable,
      planVersions: ["browser-plan-v1"],
      verifierTypes: ["dom", "url", "network", "file", "screenshot"],
      approvalMode: "per-side-effect",
    },
    desktop: {
      available: desktopBackends.length > 0,
      planVersions: ["desktop-plan-v1"],
      observe: true,
      ...(activeBackend ? { activeBackend } : {}),
      fallbackBackends: desktopBackends.filter(
        (backend) => backend !== activeBackend,
      ),
    },
    code: {
      ompRpcVersion: 2,
      verifierAdapters: codingVerifierAdapters,
    },
  };
}

function probeBrowser(): boolean {
  try {
    const executable = chromium.executablePath();
    return (
      typeof executable === "string" &&
      executable.length > 0 &&
      existsSync(executable)
    );
  } catch {
    return false;
  }
}

export async function runCapabilitiesCommand(): Promise<number> {
  const manifest = await resolveLhicHostCapabilities();
  console.log(JSON.stringify(manifest, null, 2));
  return 0;
}
