# Presentation Claim Map

This file maps the refined LHIC idea / academic presentation to repository evidence in `research/lhic-core-academic`. It exists to keep presentation statements aligned with the academic artifact and to prevent unsupported benchmark or product claims.

## Supported deck claims

| Deck topic | Supported claim | Repository evidence |
|---|---|---|
| LHIC positioning | LHIC-Core is an execution authority layer that separates planning from execution truth. | `README.md`, `paper/lhic-core-paper.md`, `docs/research/formal-model.md` |
| Plan is not proof | A proposed action or tool-call response is not by itself verified completion. | `src/receipt.ts`, `src/kernel.ts`, `docs/research/formal-model.md` |
| Policy boundary | Runtime-inferred risk is monotonic: a planner may raise but not lower independently inferred risk. | `src/policy.ts`, `test/core.test.ts` |
| Approval boundary | High-risk actions require narrow approval and cannot rely on broad reusable origin scopes. | `src/approval.ts`, `test/core.test.ts` |
| Durable ambiguity | `possibly_committed` is persisted before physical dispatch, so post-dispatch crashes do not erase uncertainty. | `src/ledger.ts`, `src/kernel.ts`, `src/boundary.ts`, `test/boundary.integration.test.ts` |
| Observe before retry | `possibly_committed`, `executed`, and `needs_resolution` are recovery states that must be observed before replay. | `src/recovery.ts`, `src/ledger.ts`, `test/kernel.integration.test.ts` |
| Hybrid execution | The academic artifact supports full-kernel execution and split-phase execution for external runners. | `src/kernel.ts`, `src/boundary.ts`, `adapters/osworld-v2/`, `docs/research/hybrid-execution-layer.md` |
| Browser surface | Controlled experiments use real Chromium and Playwright against a local HTTP fixture. | `experiments/real/browser.ts`, `experiments/real/randomized-campaign.ts`, `docs/research/current-artifact-results.md` |
| Desktop surface | Controlled experiments use Xvfb, Tk, and X11 pointer dispatch via xdotool. | `experiments/real/desktop.ts`, `experiments/real/desktop-fixture.py`, `experiments/real/randomized-campaign.ts` |
| Code surface | Controlled experiments use isolated real Git repositories. | `experiments/real/code.ts`, `experiments/real/randomized-campaign.ts` |
| Flagship real-surface result | 30 controlled flagship trials: blind retry duplicates 30/30, LHIC-Core duplicates 0/30 and verifies 30/30. | `docs/research/current-artifact-results.md`, Real Failure Injection evidence artifact |
| Randomized campaign | 108/108 seeded randomized real-surface trials pass with zero duplicate side effects. | `experiments/real/randomized-campaign.ts`, `docs/research/current-artifact-results.md` |
| Delayed visibility | Visibility delays span 41–220 ms and delayed-visibility cases require 2–6 observations without re-dispatch. | `docs/research/current-artifact-results.md` |
| Overhead | Reference-artifact median overheads are direct 0.182 ms, direct+verify 0.367 ms, split boundary 1.506 ms, full kernel 2.108 ms. | `docs/research/no-fault-overhead.md`, `docs/research/current-artifact-results.md` |
| OSWorld adapter | A split-phase OSWorld v2 bridge scaffold exists, with a pinned v2026.06.24 runner-contract check. | `adapters/osworld-v2/`, `.github/workflows/academic-artifact.yml`, `docs/research/current-artifact-results.md` |
| Claim boundary | The artifact does not claim a public OSWorld/WebArena/SWE-bench/tau-bench score or SOTA result. | `docs/research/current-artifact-results.md`, `paper/lhic-core-paper.md` |

## Claims intentionally avoided

The refined presentation should not claim:

- public benchmark superiority over Codex CLI, Goose, or any other agent;
- official OSWorld, WebArena, SWE-bench, or tau-bench performance;
- production latency from the academic atomic-JSON microbenchmark;
- general GUI or web automation accuracy from controlled fixtures;
- that external benchmark adapters are already official score submissions.

## Hybrid execution slide wording

The supported wording is:

> LHIC uses a hybrid execution boundary: full-kernel execution when LHIC owns execute/observe/verify, and split-phase execution when an external runner keeps the physical tool call while LHIC owns policy, durable pre-dispatch state, recovery, and receipts.

This replaces unsupported claims about unspecified Windows/Linux DOM leaders or benchmark speed comparisons.