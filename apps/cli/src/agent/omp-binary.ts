import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  resolveOmpBinary as resolveShared,
  type OmpVersionPolicy,
} from "@lhic/omp-rpc";

export { DEFAULT_OMP_VERSION, isNewerOmpVersion } from "@lhic/omp-rpc";
export type { OmpVersionPolicy } from "@lhic/omp-rpc";

/**
 * Resolves the omp binary. Default policy is `managed` (auto-update within
 * the compatibility gate); benchmark and release invocations MUST pass a
 * `pinned` policy so runs never silently change the omp core.
 */
export function resolveOmpBinary(policy?: OmpVersionPolicy): Promise<string> {
  return resolveShared(policy ? { policy } : {});
}

/** Cache root used for omp versions and agent session files. */
export function ompCacheDirectory(): string {
  return resolve(
    process.env.LHIC_OMP_CACHE_DIR ?? join(homedir(), ".cache", "lhic", "omp"),
  );
}
