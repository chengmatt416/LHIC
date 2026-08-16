# Harness Comparator Baselines

This document separates three kinds of comparator evidence used by LHIC-Core:

1. the original matched blind-retry control used in the real Browser/Desktop/Git crash experiment;
2. synthetic ablations used to explain mechanism contributions; and
3. **real named public-harness runs** using official Codex CLI and Goose binaries.

No public benchmark score is implied by any of these comparisons.

## 1. Matched blind-retry control

The flagship real-surface experiment holds the logical action, fixture, external side effect, injected post-commit / pre-response crash window, and trial count constant. The manipulated variable is recovery policy.

Observed result:

| Surface | Trials | Blind-retry duplicate trials | LHIC duplicate trials | LHIC verified recovery |
|---|---:|---:|---:|---:|
| Browser / Chromium | 10 | 10 / 10 | 0 / 10 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 / 10 | 0 / 10 | 10 / 10 |
| Code / Git | 10 | 10 / 10 | 0 / 10 | 10 / 10 |
| **Total** | **30** | **30 / 30** | **0 / 30** | **30 / 30** |

This is the strongest causal control for the lost-response recovery mechanism because only recovery policy differs.

## 2. Synthetic mechanism ablation

The deterministic simulator runs 100 modeled trials per strategy across five failure modes.

| Harness strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla / no durable recovery | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

The synthetic ablation is used to explain why durable ambiguity and verification are complementary. It is not a named public-harness result.

## 3. Real named public-harness comparison

A separate controlled fixture was executed using official public harness binaries:

- OpenAI Codex CLI `0.147.0`;
- Goose `1.46.0` with the official built-in `developer` extension;
- LHIC-Core from `research/lhic-core-academic`.

The planner is replaced with the same deterministic local Responses-compatible provider for every public harness so planner intelligence is not a variable.

### No-fault condition

All three harnesses execute the durable side effect exactly once:

| Harness | Trials | Second physical dispatches | Duplicate side effects |
|---|---:|---:|---:|
| Codex CLI 0.147.0 | 10 | 0 / 10 | 0 |
| Goose 1.46.0 | 10 | 0 / 10 | 0 |
| LHIC-Core | 10 | 0 / 10 | 0 |

### Post-commit tool-error condition

The side effect is durably committed first; the tool then exits non-zero. On the next model turn, the deterministic planner proposes the identical logical action again.

| Harness | Trials | Second physical dispatches | Duplicate side effects | Mean physical effects |
|---|---:|---:|---:|---:|
| **Codex CLI 0.147.0** | 10 | **10 / 10** | **10** | **2.0** |
| **Goose 1.46.0** | 10 | **10 / 10** | **10** | **2.0** |
| **LHIC-Core** | 10 | **0 / 10** | **0** | **1.0** |

The LHIC durable ledger is `verified` in 10 / 10 post-commit-error trials.

This result was reproduced in an earlier workflow execution with the same aggregate outcome. See `docs/research/public-harness-comparator-results.md` for exact versions, workflow IDs, artifact IDs, SHA-256 digests, raw-trace interpretation, and limitations.

## Interpretation boundary

The public-harness comparison measures **execution-layer behavior after a fixed retry-oriented planner proposes the same logical action again**.

It does **not** claim that Codex or Goose would autonomously choose the same retry under their normal production models. It also does not compare general reasoning quality, task success, latency, OSWorld, WebArena, SWE-bench, or any leaderboard score.

OpenHands remains unmeasured and must not be shown as a numerical result.