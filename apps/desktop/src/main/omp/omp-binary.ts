import { app } from "electron";
import { join } from "node:path";

import { resolveOmpBinary as resolveWithUpdates } from "@lhic/omp-rpc";

/**
 * The omp binary bundled with this build (env override, packaged
 * resources/omp, or the vendored development copy).
 */
export function resolveBundledOmpBinary(): string {
  if (process.env.OMP_BINARY) {
    return process.env.OMP_BINARY;
  }
  const fileName = process.platform === "win32" ? "omp.exe" : "omp";
  if (app.isPackaged) {
    return join(process.resourcesPath, "omp", fileName);
  }
  return join(app.getAppPath(), "vendor", "omp", "current", fileName);
}

/**
 * Resolves the omp RPC engine binary for this session, preferring an
 * auto-updated cache version when omp has published a newer release. The
 * bundled binary is the fallback for the pinned version, so nothing is
 * downloaded when the bundled omp is current.
 */
export function resolveOmpBinary(): Promise<string> {
  return resolveWithUpdates({ bundledBinary: resolveBundledOmpBinary() });
}
