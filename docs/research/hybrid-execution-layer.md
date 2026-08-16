# Hybrid Execution Layer

This document records the presentation-facing hybrid execution claims for the academic branch. It intentionally separates **validated academic artifact evidence** from **platform-adapter design intent**.

## Core idea

LHIC-Core separates planning from execution authority. A planner may propose an action, but every physical action must cross the same policy, approval, durable-ledger, executor, observation, and verifier boundaries.

The academic branch supports two complementary execution forms:

1. **Full-kernel execution**, where the TypeScript `LhicResearchKernel` owns execute / observe / verify adapters; and
2. **Split-phase execution**, where an external runner keeps control of the physical tool call while `SplitExecutionBoundary` owns durable pre-dispatch state and recovery semantics.

The presentation describes this as a **hybrid execution layer**: LHIC chooses the most deterministic local path available, then falls back through increasingly general layers while preserving the same approval, durable-ledger, and verification boundary.

## Presentation hybrid stack

The presentation-facing execution stack is:

| Priority | Layer | Role | Claim boundary |
|---:|---|---|---|
| 1 | Browser DOM / app-specific deterministic skill | Use structured DOM/API targets when available | Validated in controlled Chromium fixtures, not an open-world browser benchmark |
| 2 | macOS native UI adapter using Peekaboo | Use macOS screen/accessibility automation when DOM-level control is unavailable | Platform design path; academic artifact validates the same boundary semantics using controlled desktop fixtures |
| 3 | Windows native UI adapter using FlaUI | Use Windows UI Automation through a FlaUI-style adapter for native apps | Platform design path; no public Windows benchmark score is claimed |
| 4 | Linux native UI adapter with the same adapter contract | Use a FlaUI-style command contract over Linux accessibility/input primitives where available | Platform design path; the phrase “FlaUI-style” describes the adapter contract, not a claim that the Windows FlaUI library itself is cross-platform |
| 5 | OmniParser visual fallback | Parse screenshots into UI elements and expose visual context to an AI planner for pure-vision operation | Fallback design path; not used as a public benchmark result in the current artifact |
| 6 | LHIC traditional execution layer | Use the slower existing execution path when structured, native, or visual adapters are unavailable | Fallback design path; still passes through policy, durable state, and verifier semantics |

This hierarchy is intentionally conservative. The faster adapter is not allowed to bypass risk classification, approval, durable `possibly_committed` state, replay blocking, or verifier evidence.

## Validated execution surfaces

The controlled real-surface experiments validate representative local execution surfaces:

| Surface | Academic implementation | Evidence source | Claim boundary |
|---|---|---|---|
| Browser DOM / page action | `experiments/real/browser.ts` uses Chromium + Playwright against a local HTTP server | flagship real-surface experiment and randomized campaign | controlled local browser fixture, not open-world browsing accuracy |
| Desktop UI action | `experiments/real/desktop.ts` and `desktop-fixture.py` use Xvfb, Tk, and X11 pointer dispatch via `xdotool` | flagship real-surface experiment and randomized campaign | controlled native desktop fixture, not general GUI task success |
| Code / workspace action | `experiments/real/code.ts` uses an isolated real Git repository | flagship real-surface experiment and randomized campaign | controlled Git-side side effect, not SWE-bench performance |

The current evidence validates the **execution boundary semantics** across browser, desktop, and code surfaces. It does not claim that every platform adapter above has been benchmarked externally.

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
