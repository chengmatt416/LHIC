# Hybrid Execution Layer

This document records the presentation-facing hybrid execution claims for the academic branch. It intentionally limits the claim to what is implemented or validated in `research/lhic-core-academic`.

## Core idea

LHIC-Core separates planning from execution authority. A planner may propose an action, but every physical action must cross the same policy, approval, durable-ledger, executor, observation, and verifier boundaries.

The academic branch supports two complementary execution forms:

1. **full-kernel execution**, where the TypeScript `LhicResearchKernel` owns execute / observe / verify adapters; and
2. **split-phase execution**, where an external runner keeps control of the physical tool call while `SplitExecutionBoundary` owns durable pre-dispatch state and recovery semantics.

## Validated execution surfaces

The controlled real-surface experiments validate the following local execution surfaces:

| Surface | Academic implementation | Evidence source | Claim boundary |
|---|---|---|---|
| Browser DOM / page action | `experiments/real/browser.ts` uses Chromium + Playwright against a local HTTP server | flagship real-surface experiment and randomized campaign | controlled local browser fixture, not open-world browsing accuracy |
| Desktop UI action | `experiments/real/desktop.ts` and `desktop-fixture.py` use Xvfb, Tk, and X11 pointer dispatch via `xdotool` | flagship real-surface experiment and randomized campaign | controlled native desktop fixture, not general GUI task success |
| Code / workspace action | `experiments/real/code.ts` uses an isolated real Git repository | flagship real-surface experiment and randomized campaign | controlled Git-side side effect, not SWE-bench performance |
| External benchmark bridge | `adapters/osworld-v2/` provides a Python wrapper, persistent Node bridge, and TypeScript durable boundary | Academic CI bridge tests and pinned OSWorld v2026.06.24 runner-contract check | adapter scaffold only, not an official OSWorld score |

## Validated randomized fault coverage

The randomized layer exercises browser, desktop, and code surfaces across six fault modes:

1. pre-dispatch failure;
2. post-commit lost response;
3. delayed visibility;
4. partial postcondition;
5. duplicate logical delivery;
6. late completion after recovery.

Across two deterministic timing seeds, the campaign executes 108 controlled real-surface trials. The recorded result is 108/108 pass with zero duplicate side effects. Visibility delays span 41–220 ms, and delayed-visibility trials require 2–6 recovery observations while still physically dispatching exactly once.

## No-fault overhead boundary

The academic microbenchmark measures reference-artifact overhead for a local code-side marker action. It uses atomic JSON persistence and should not be interpreted as product SQLite latency, browser latency, OSWorld latency, or remote API latency.

Recorded medians:

| Variant | Median |
|---|---:|
| Direct execute | 0.182 ms |
| Direct execute + read-back verification | 0.367 ms |
| Split durable boundary | 1.506 ms |
| Full LHIC-Core | 2.108 ms |

Median deltas:

```text
split boundary - direct execute       = +1.324 ms
full kernel - direct execute + verify = +1.741 ms
```

## Claims explicitly not made

The academic branch does not claim that LHIC is faster than Codex CLI, Goose, or any other public agent on a benchmark. It does not claim a public OSWorld, WebArena, SWE-bench, or tau-bench score. It also does not claim general computer-use accuracy from the controlled fixtures.

The supported claim is narrower: under validated controlled faults, the hybrid execution boundary preserved durable ambiguity, avoided blind replay, and produced zero duplicate side effects across the recorded real-surface campaigns.
