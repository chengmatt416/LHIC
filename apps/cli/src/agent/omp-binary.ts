import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveOmpBinary as resolveShared } from "@lhic/omp-rpc";

export { DEFAULT_OMP_VERSION, isNewerOmpVersion } from "@lhic/omp-rpc";

/** Resolves the omp binary, auto-updating the core when a newer release exists. */
export function resolveOmpBinary(): Promise<string> {
  return resolveShared();
}

/** Cache root used for omp versions and agent session files. */
export function ompCacheDirectory(): string {
  return resolve(
    process.env.LHIC_OMP_CACHE_DIR ?? join(homedir(), ".cache", "lhic", "omp"),
  );
}
