# LHIC-Core Academic Artifact

**Crash-consistent, evidence-carrying execution for autonomous agents.**

This branch is the research-facing extraction of LHIC. It removes the product shell and keeps the mechanisms needed to study one question:

> How should an autonomous agent execute real side effects when tool calls are non-atomic, outcomes can be ambiguous, and model output is not trustworthy execution evidence?

## Research thesis

LHIC-Core treats planning and execution truth as different concerns. A model or agent proposes an action, while a deterministic runtime owns risk classification, approval scope, durable side-effect state, recovery, postcondition verification, and evidence-carrying receipts.

```text
planner / human intent
        |
        v
independent risk classification
        |
        v
scope-bound approval
        |
        v
persist possibly_committed BEFORE external dispatch
        |
        v
execution adapter / external benchmark runner
        |
        +---- completion ----------> executed, then verify independently
        |
        +---- crash / timeout -----> re-observe external state
                                      | present -> verify; no replay
                                      | absent  -> explicit resolution state
                                      | unclear -> needs_resolution
```

`needs_resolution` remains a recovery state: later invocations re-observe rather than silently returning to normal dispatch.

## What was extracted from the product branch

The academic kernel is derived from `feature/sota-improvements`, but rewritten to remove product dependencies and expose research invariants directly:

- action receipts and side-effect taxonomy;
- independent/effective side-effect classification;
- narrow approval scopes and high-risk exclusions;
- crash-safe side-effect ledger semantics;
- evidence-backed verification;
- trust-aware skill promotion.

The branch excludes the Electron app, installer, OMP product/UI integration, Appwrite services, release tooling, and provider-specific model setup.

## Repository map

### Research kernel

- `src/model.ts` — action, approval, ledger, evidence, receipt, and memory types.
- `src/policy.ts` — independent risk inference and monotonic effective risk.
- `src/approval.ts` — bounded approval scopes.
- `src/ledger.ts` — persistent fail-closed state transitions.
- `src/recovery.ts` — observe-before-replay recovery decisions.
- `src/receipt.ts` — authority-separated evidence-carrying receipts.
- `src/memory.ts` — evidence-gated trusted promotion and staleness.
- `src/kernel.ts` — monolithic reference execution protocol.
- `src/boundary.ts` — split-phase boundary for external runners that retain control of physical dispatch.

### Tests and ablations

- `test/core.test.ts` — 6 core invariants.
- `test/kernel.integration.test.ts` — 2 crash/recovery integration tests.
- `test/recovery-matrix.test.ts` — 5 ambiguity/recovery tests.
- `test/boundary.integration.test.ts` — 3 split-phase boundary tests.
- `benchmark/failure-injection.ts` — deterministic synthetic strategy ablation.
- `benchmark/no-fault-overhead.ts` — paired reference-artifact overhead experiment.

Current Node.js test count: **16**.

### Real failure injection

- `experiments/real/browser.ts` — real Chromium + HTTP form side effects.
- `experiments/real/desktop.ts` — real X11/Tk actions through `xdotool`.
- `experiments/real/desktop-fixture.py` — native GUI fixture with committed count and complete/partial postcondition state.
- `experiments/real/code.ts` — real isolated Git edits and commits.
- `experiments/real/run-all.ts` — flagship 30-trial suite.
- `experiments/real/failure-matrix.ts` — five-case semantic matrix.
- `experiments/real/randomized-campaign.ts` — seeded six-mode cross-surface campaign.

### OSWorld 2.0 adapter

- `adapters/osworld-v2/runner_boundary.py` — thin wrapper around official `env.step(...)`.
- `adapters/osworld-v2/bridge_client.py` — persistent Python client.
- `adapters/osworld-v2/bridge_server.ts` — JSONL TypeScript service backed by `SplitExecutionBoundary`.
- `adapters/osworld-v2/test_runner_boundary.py` — benchmark-side ordering tests.
- `adapters/osworld-v2/test_bridge_client.py` — Python→Node→TypeScript durable restart/recovery tests.
- `adapters/osworld-v2/check_pinned_contract.py` — checks the pinned upstream runner still exposes the expected planner/action/`env.step` boundary.

A successful benchmark executor return is recorded as `executed`, **not** LHIC-verified. Verification remains evidence-driven.

### Research documentation

- `docs/research/formal-model.md`
- `docs/research/ablation-matrix.md`
- `docs/research/evaluation-protocol.md`
- `docs/research/current-artifact-results.md`
- `docs/research/real-failure-injection.md`
- `docs/research/failure-matrix.md`
- `docs/research/randomized-cross-surface.md`
- `docs/research/no-fault-overhead.md`
- `docs/research/code-provenance.md`
- `docs/research/academic-positioning.md`
- `docs/research/references.md`
- `paper/lhic-core-paper.md`

## Current controlled evidence

### Flagship post-commit crash

| Surface | Blind-retry duplicates | LHIC duplicates | LHIC verified recovery |
|---|---:|---:|---:|
| Chromium | 10/10 | 0/10 | 10/10 |
| X11/Tk | 10/10 | 0/10 | 10/10 |
| Git | 10/10 | 0/10 | 10/10 |
| **Total** | **30/30** | **0/30** | **30/30** |

### Five-case semantic matrix

Pre-dispatch ambiguity, delayed visibility, persistent inconclusive observation, duplicate logical delivery, and workspace conflict all pass the hard no-replay gates.

### Seeded randomized campaign

```text
3 surfaces x 6 fault modes x 3 trials x 2 seeds = 108 trials
```

Result:

- **108 / 108 passed**;
- **0 duplicate side effects**;
- delayed visibility required **2–6 recovery observations**;
- injected visibility delay covered **41–220 ms**;
- every accepted logical action physically dispatched at most once.

These remain controlled-fixture results, not official benchmark scores.

### Paired no-fault academic overhead

80 trials per variant on a local marker action:

| Variant | Median | p95 |
|---|---:|---:|
| Direct execute | 0.182 ms | 0.291 ms |
| Direct + read-back verify | 0.367 ms | 0.553 ms |
| Split durable boundary | 1.506 ms | 1.777 ms |
| Full LHIC-Core | 2.108 ms | 2.667 ms |

These numbers describe the atomic-JSON **academic reference implementation**, not production latency.

## Run the artifact

Node.js 22.6+ can execute the TypeScript directly.

```bash
npm test
npm run bench
npm run bench:overhead
```

Flagship real suite + semantic matrix:

```bash
LHIC_REAL_TRIALS=3 npm run experiment:real
```

Seeded randomized campaign:

```bash
LHIC_CAMPAIGN_TRIALS=3 LHIC_CAMPAIGN_SEED=2026-08-15 npm run experiment:randomized
```

Full local experiment layer:

```bash
npm run experiment:full
```

Browser runs require pinned Playwright + Chromium; desktop runs require Xvfb, `xdotool`, and Tk; code runs require Git.

## Primary research contributions

1. **Crash-consistent side-effect semantics.** Ambiguous external outcomes become persistent runtime state rather than implicit tool-call failure.
2. **Observe-before-replay recovery.** The runtime observes the external world before replaying a possibly committed action.
3. **Authority-separated receipts.** Planner, approver, executor, verifier, and evidence remain distinct facts.
4. **Policy-bound execution.** Planner-supplied risk labels may raise effective risk but may never lower independently inferred risk.
5. **Trust-aware learned behavior.** Reusable behavior requires multiple independent verified tasks plus holdout success.
6. **Split-phase external-runner boundary.** Benchmark/framework runners can preserve their own physical dispatch while LHIC owns durable ambiguity and recovery state.

## Claim boundary

A defensible current claim is:

> In validated controlled fixtures, LHIC-Core prevented duplicate replay in the flagship post-commit crash experiment and matched the expected durable execution state in 108/108 additional seeded browser, desktop, and code trials spanning six non-atomic execution variants, with zero duplicate side effects. The same durable semantics are exposed through a tested split-phase Python→Node→TypeScript boundary for an OSWorld-style external runner.

This is not an official OSWorld/SWE-bench/tau-bench result and not a production latency claim.

## Suggested paper title

**LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents**
