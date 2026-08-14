# Claim matrix

| Claim | Required evidence | Current evidence | Status |
|---|---|---|---|
| Cross-surface receipts with explicit authority | Receipt schema + OMP/browser/desktop adapters | Implemented; tests green | Pass |
| Crash-safe side-effect recovery | Durable ledger + kill-injection tests | Implemented; deterministic recovery tests | Pass |
| Structured policy, planner cannot understate risk | Taxonomy + fuzz + negative tests | Implemented; deterministic fuzz | Pass |
| Objective coding verification | Adapters + evidence model + tests | Implemented | Pass |
| Same-repo conflict awareness | Read sets + conflict gate + restart persistence | Implemented | Pass |
| Memory trust/staleness/recipes/signed skills | Stores + signatures + guards | Implemented | Pass |
| Signed benchmark evidence | Manifest + signing + validation | Implemented; official runs require external credentials | Not evaluated |
| Desktop observation benchmark | Deterministic fixtures + scorer | Implemented | Pass |
| Official OSWorld/τ/SWE-bench scores | Official evaluator output | Adapters + pinned revisions ready; runs blocked on external prerequisites | Not evaluated |

Allowed wording: "LHIC outperformed comparator X on the pinned LHIC
agent-competitive suite under the documented model/version configuration."
Never "SOTA" / "beats Codex generally" from local suites. Only after
official evaluator results, state the exact benchmark, revision, model, and
score.
