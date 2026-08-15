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
execution adapter
        |
        +---- completion ----------> verify independently
        |
        +---- crash / timeout -----> re-observe external state
                                      | present -> verify; no replay
                                      | absent  -> explicit resolution state
                                      | unclear -> needs_resolution
```

`needs_resolution` is itself a recovery state: later invocations re-observe rather than silently returning to normal dispatch.

## What was extracted from the product branch

The academic kernel is derived from the mechanisms in `feature/sota-improvements`, but rewritten to remove product dependencies and expose research invariants directly:

- action receipts and side-effect taxonomy;
- independent/effective side-effect classification;
- narrow approval scopes and high-risk exclusions;
- crash-safe side-effect ledger semantics;
- evidence-backed verification;
- trust-aware skill promotion.

The academic branch excludes the Electron app, installer, OMP UI/product integration, Appwrite services, release tooling, and provider-specific model setup.

## Repository map

### Executable research kernel

- `src/model.ts` — academic action, approval, ledger, evidence, receipt, and memory types.
- `src/policy.ts` — independent risk inference and “planner may raise risk, never lower it.”
- `src/approval.ts` — bounded approval scopes.
- `src/ledger.ts` — persistent fail-closed state transitions.
- `src/recovery.ts` — observe-before-replay recovery decisions.
- `src/receipt.ts` — authority-separated evidence-carrying receipts.
- `src/memory.ts` — evidence-gated trusted promotion and staleness.
- `src/kernel.ts` — composition of policy, ledger, execution, observation, verification, and recovery.

### Tests and synthetic ablation

- `test/core.test.ts` — 6 core invariant checks.
- `test/kernel.integration.test.ts` — 2 crash/recovery integration tests.
- `test/recovery-matrix.test.ts` — 5 adjacent recovery-semantic tests.
- `benchmark/failure-injection.ts` — deterministic synthetic strategy ablation.

Current Node.js test count: **13**.

### Real failure-injection experiments

- `experiments/real/browser.ts` — real Chromium + HTTP form side effects.
- `experiments/real/desktop.ts` — real X11/Tk actions through `xdotool`.
- `experiments/real/desktop-fixture.py` — native GUI fixture with committed count and complete/partial postcondition state.
- `experiments/real/code.ts` — real isolated Git edits and commits.
- `experiments/real/run-all.ts` — flagship 30-trial real-surface suite.
- `experiments/real/failure-matrix.ts` — five-case recovery-semantics matrix.
- `experiments/real/randomized-campaign.ts` — seeded six-mode cross-surface campaign.

### External benchmark adapters

- `adapters/osworld-v2/runner_boundary.py` — thin benchmark-side boundary around official `env.step(...)` execution.
- `adapters/osworld-v2/test_runner_boundary.py` — validates persistence-before-dispatch ordering and lost-response handling.
- `adapters/osworld-v2/README.md` — pinned benchmark integration and claim discipline.

The adapter scaffold does not change official benchmark scoring and does not treat an executor return as LHIC verification.

### Research documentation

- `docs/research/formal-model.md`
- `docs/research/ablation-matrix.md`
- `docs/research/evaluation-protocol.md`
- `docs/research/current-artifact-results.md`
- `docs/research/real-failure-injection.md`
- `docs/research/failure-matrix.md`
- `docs/research/randomized-cross-surface.md`
- `docs/research/code-provenance.md`
- `docs/research/academic-positioning.md`
- `docs/research/references.md`
- `paper/lhic-core-paper.md`

## Current controlled evidence

### Flagship post-commit crash experiment

10 trials per real surface:

| Surface | Blind-retry duplicates | LHIC duplicates | LHIC verified recovery |
|---|---:|---:|---:|
| Chromium | 10/10 | 0/10 | 10/10 |
| X11/Tk | 10/10 | 0/10 | 10/10 |
| Git | 10/10 | 0/10 | 10/10 |
| **Total** | **30/30** | **0/30** | **30/30** |

### Five-case semantic matrix

Pre-dispatch ambiguity, delayed visibility, persistent inconclusive observation, duplicate logical delivery, and workspace conflict all pass the hard no-replay acceptance gates.

### Seeded randomized real-surface campaign

Two timing seeds run:

```text
3 surfaces x 6 fault modes x 3 trials x 2 seeds = 108 trials
```

Result:

- **108 / 108 passed**;
- **0 duplicate side effects**;
- delayed visibility required **2–6 recovery observations**;
- injected visibility delays covered **41–220 ms**;
- every accepted logical action physically dispatched at most once.

These are controlled-fixture results, not official benchmark scores.

## Run the artifact

Node.js 22.6+ can execute the TypeScript reference code directly.

```bash
npm test
npm run bench
```

### Real-surface experiments

Flagship browser/desktop/code suite + semantic matrix:

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

Browser experiments require pinned Playwright + Chromium; desktop experiments require Xvfb, `xdotool`, and Tk. Git experiments require Git.

Machine-readable output is written under `artifacts/`.

## Primary research contributions

1. **Crash-consistent side-effect semantics.** Ambiguous external outcomes become persistent runtime state rather than implicit tool-call failure.
2. **Observe-before-replay recovery.** The runtime observes the external world before replaying a possibly committed action.
3. **Authority-separated receipts.** Planner, approver, executor, verifier, and evidence remain distinct facts.
4. **Policy-bound execution.** Planner-supplied risk labels may raise effective risk but may never lower independently inferred risk.
5. **Trust-aware learned behavior.** Reusable behavior requires multiple independent verified tasks plus holdout success.

## Claim boundary

The intended claim is not “LHIC is a smarter planner” or “LHIC is universally SOTA.” A defensible current claim is:

> In the validated controlled fixtures, LHIC-Core prevented duplicate replay in the flagship post-commit crash experiment and matched the expected durable execution state in 108/108 additional seeded browser, desktop, and code trials spanning six non-atomic execution variants, with zero duplicate side effects.

External validity still requires a real bridge into pinned official benchmark runners and official evaluator output. Performance claims also require paired no-fault overhead experiments.

## Suggested paper title

**LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents**
