import type { ObservationOutcome, SideEffectLedgerEntry } from "./model.ts";

export type RecoveryDecision =
  | { decision: "do_not_replay"; nextState: "verified" | "executed"; reason: string }
  | { decision: "safe_to_retry"; nextState: "needs_resolution"; reason: string }
  | { decision: "human_resolution"; nextState: "needs_resolution"; reason: string };

/**
 * Recovery is evidence-driven. A timeout or crash is not interpreted as
 * failure; it is interpreted as uncertainty about the external world.
 */
export function decideRecovery(
  entry: SideEffectLedgerEntry,
  observation: ObservationOutcome,
  verifierPassed: boolean,
): RecoveryDecision {
  if (entry.state === "verified") {
    return {
      decision: "do_not_replay",
      nextState: "verified",
      reason: "Verified effects are terminal and must never be replayed.",
    };
  }

  if (observation === "effect_present") {
    return verifierPassed
      ? {
          decision: "do_not_replay",
          nextState: "verified",
          reason: "External effect exists and verifier passed.",
        }
      : {
          decision: "do_not_replay",
          nextState: "executed",
          reason: "Effect appears present; retry would risk duplication.",
        };
  }

  if (observation === "effect_absent") {
    return {
      decision: "safe_to_retry",
      nextState: "needs_resolution",
      reason: "Observation indicates the side effect did not occur; retry may be admitted by policy.",
    };
  }

  return {
    decision: "human_resolution",
    nextState: "needs_resolution",
    reason: "Outcome remains ambiguous; fail closed rather than replay blindly.",
  };
}
