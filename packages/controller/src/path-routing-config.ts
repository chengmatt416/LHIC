import { isExecutionProfile, type ExecutionProfile } from "@lhic/schema";

export type PathRoutingMode = "legacy" | "shadow" | "enabled";

export interface PathRoutingConfig {
  mode: PathRoutingMode;
  defaultProfile: ExecutionProfile;
}

/**
 * Defaults to legacy execution so introducing the scheduler cannot alter a
 * running deployment until operators first inspect shadow-route evidence.
 */
export function readPathRoutingConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PathRoutingConfig {
  const rawMode = environment.LHIC_PATH_ROUTING_MODE ?? "legacy";
  if (!isPathRoutingMode(rawMode)) {
    throw new Error(
      "LHIC_PATH_ROUTING_MODE must be legacy, shadow, or enabled.",
    );
  }
  const rawProfile = environment.LHIC_EXECUTION_PROFILE ?? "fast_only";
  if (!isExecutionProfile(rawProfile)) {
    throw new Error(
      "LHIC_EXECUTION_PROFILE must be fast_only, balanced, or deliberative.",
    );
  }
  return { mode: rawMode, defaultProfile: rawProfile };
}

export function isPathRoutingMode(value: unknown): value is PathRoutingMode {
  return value === "legacy" || value === "shadow" || value === "enabled";
}
