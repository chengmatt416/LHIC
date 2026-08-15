# Expanded Failure Matrix

This document records the second-layer controlled evaluation beyond the flagship post-commit / pre-response crash case.

The matrix is still an artifact-validation harness, not an official benchmark. It varies the failure semantics while holding the reference kernel fixed.

## Failure modes

| Case | External effect | Observation | Expected LHIC behavior |
|---|---|---|---|
| Pre-dispatch crash | no effect | absent | keep `needs_resolution`; do not silently replay |
| Delayed visibility | committed effect | first inconclusive, later present | remain non-dispatchable, later verify without duplicate |
| Inconclusive observation | committed effect | always inconclusive | remain `needs_resolution`, no replay |
| Duplicate delivery | committed + response received | duplicate logical delivery | verified identity blocks second dispatch |
| Workspace conflict | committed effect plus external mutation | present but verifier fails | do not replay; remain executed/unverified |

## Latest result

Validated on commit `18c6ababa50b6f7a63afc49708cb7ebb1fc01201`, workflow run `31879578627`, artifact `9245677516`.

| Case | Expected final state | Observed state | Durable ledger state | Dispatches | Observations | Verifications | Side effects | Duplicate effects | Result |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| Pre-dispatch crash | `needs_resolution` | `needs_resolution` | `needs_resolution` | 1 | 1 | 0 | 0 | 0 | PASS |
| Delayed visibility | `verified` | `verified` | `verified` | 1 | 2 | 1 | 1 | 0 | PASS |
| Inconclusive observation | `needs_resolution` | `needs_resolution` | `needs_resolution` | 1 | 1 | 0 | 1 | 0 | PASS |
| Duplicate delivery | `executed` receipt / `verified` ledger | `executed` | `verified` | 1 | 0 | 1 | 1 | 0 | PASS |
| Workspace conflict | `executed` | `executed` | `executed` | 1 | 1 | 1 | 1 | 0 | PASS |

The machine-readable artifact includes per-case latency. Those values are useful for sanity checking but are not treated as optimized performance results.

## Why this matters

The first real-surface experiment demonstrated that LHIC-Core prevents duplicate replay when the external effect commits before the dispatcher crash. The expanded matrix tests whether that guarantee generalizes to adjacent ambiguity states:

- no physical effect happened;
- the effect is delayed or not yet observable;
- the effect is present but verification cannot accept it;
- a verified action is delivered again;
- the workspace changes underneath recovery.

## Acceptance gate

Every matrix case must satisfy:

```text
physical dispatches <= 1
duplicate side effects = 0
recovered state matches expected semantics
```

A case may end in `needs_resolution` or `executed` rather than `verified`; that is intentional when evidence is absent or conflicting. The research claim is not that LHIC always completes, but that it does not blindly replay ambiguous effects.

## Relationship to the real-surface suite

The browser / desktop / code suite validates the flagship failure window against real Chromium, X11/Tk, and Git boundaries. The expanded matrix is faster and isolates additional semantic variants. Both are needed: one establishes real process-boundary behavior; the other stresses the transition relation.
