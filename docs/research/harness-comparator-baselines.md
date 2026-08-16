# Harness Comparator Baselines

This document defines the comparator harnesses used in the presentation. The goal is to make the experimental contrast explicit without inventing unrun public benchmark results.

## Why the control group is a harness

The primary comparison is not LHIC-Core versus a different planner model. It is a systems comparison between recovery policies under the same non-atomic failure window.

The controlled fixture holds the following constant:

- the same logical action;
- the same browser, desktop, or Git surface;
- the same external side effect;
- the same injected post-commit / pre-response failure;
- the same trial count.

The manipulated variable is the harness behavior after the completion response is lost.

## Comparator harnesses

### 1. No-durable-recovery harness

This harness represents a common agent-loop failure mode: after an action is dispatched and the completion response is lost, the harness has no durable `possibly_committed` record and dispatches the same logical action again.

This is the matched control used in the flagship real-surface comparison.

Observed result in the controlled flagship experiment:

| Surface | Trials | Duplicate trials |
|---|---:|---:|
| Browser / Chromium | 10 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 / 10 |
| Code / Git | 10 | 10 / 10 |
| **Total** | **30** | **30 / 30** |

### 2. Verify-after-execute harness

This harness can check state after a returned action result, but it does not persist a durable ambiguity state before dispatch. It is useful for detecting some false-success cases but still cannot reliably recover from the post-commit / pre-response failure interval.

In the synthetic ablation harness, the verifier-only strategy reduces duplicate side effects relative to vanilla behavior but does not eliminate them.

### 3. Ledger-only harness

This harness persists ambiguity and blocks blind replay, but without independent postcondition verification it often requires human resolution.

In the synthetic ablation harness, the ledger-only strategy eliminates duplicate side effects but produces high human-resolution demand.

### 4. LHIC-Core full harness

LHIC-Core combines durable pre-dispatch ambiguity, independent postcondition verification, action identity, bounded approval, and replay blocking.

Observed result in the controlled flagship experiment:

| Surface | Trials | Duplicate trials | Verified recovery |
|---|---:|---:|---:|
| Browser / Chromium | 10 | 0 / 10 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 0 / 10 | 10 / 10 |
| Code / Git | 10 | 0 / 10 | 10 / 10 |
| **Total** | **30** | **0 / 30** | **30 / 30** |

## Synthetic ablation summary

The synthetic harness runs 100 deterministic trials per strategy over five modeled failure modes.

| Harness strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla / no durable recovery | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

The synthetic ablation is not a public benchmark. It is used to explain why LHIC-Core needs both durable ambiguity and verification.

## Public harnesses

This document does not report results for named public harnesses such as Codex CLI, Goose, OpenHands, or other agent products. Those comparisons require live adapter-based runs under the same injected failure window and should be reported separately when executed.

The presentation may mention those systems only as future comparator targets, not as measured results.
