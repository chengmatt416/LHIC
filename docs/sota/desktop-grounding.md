# Desktop grounding

Observations carry a stable `observationId` tying targets to their source
tree. Fallback chains are recorded as `BackendAttemptEvidence`; semantic
failure is never silently converted to raw coordinates. The desktop
observation benchmark (`lhic bench desktop-observation`) scores 8
deterministic fixtures (unique/duplicate labels, multilingual, stale tree,
moved target, DPI scaling, occlusion, dynamic layout) for recall,
uniqueness, label accuracy, stale-target rate, fallback rate, coordinate
error, and false matches.
