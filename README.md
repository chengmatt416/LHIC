# LHIC-Core Academic Artifact

**Crash-consistent, evidence-carrying execution for autonomous agents.**

This branch is the research-facing extraction of LHIC. It deliberately removes the product shell and keeps only the mechanisms needed to study one question:

> How should an autonomous agent execute real side effects when tool calls are non-atomic, outcomes can be ambiguous, and model output is not trustworthy execution evidence?

## Research thesis

LHIC-Core treats planning and execution truth as different concerns. A model or agent may propose an action, but a deterministic runtime owns risk classification, approval scope, durable side-effect state, postcondition verification, recovery, and evidence-carrying receipts.

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
        v
postcondition verifier
        |
        +---- success + evidence ----> verified receipt
        |
        +---- crash / timeout -------> re-observe external state
                                        | present -> verify; do not replay
                                        | absent  -> needs_resolution / policy analysis
                                        | unclear -> needs_resolution
```

A central recovery invariant is now explicit: `possibly_committed`, `executed`, and `needs_resolution` are unresolved recovery states. A later call must re-observe them before any new physical dispatch.

## What was extracted from the product branch

The reference implementation is derived from `feature/sota-improvements` at product commit `f519c94eadee15d0f4b4995995f6054326a39c24`, but rewritten to remove product dependencies and expose the research invariants directly:

- action receipts and side-effect taxonomy;
- independent/effective side-effect classification;
- narrow approval scopes and high-risk exclusions;
- crash-safe side-effect ledger semantics;
- evidence-backed verification;
- trust-aware skill promotion.

The academic branch does **not** copy the Electron app, installer, OMP UI integration, Appwrite services, release tooling, or provider-specific model setup.

## Repository map

### Executable research kernel

- `src/model.ts` — minimal academic types for actions, approvals, ledger entries, receipts, evidence, and memory.
- `src/policy.ts` — conservative independent side-effect classification and the “planner may raise risk, never lower it” rule.
- `src/approval.ts` — exact-action, plan-step, read-only, and bounded origin/class approval scopes.
- `src/ledger.ts` — persistent reference ledger with atomic JSON replacement and fail-closed state transitions.
- `src/recovery.ts` — observe/verify-before-retry recovery semantics.
- `src/receipt.ts` — authority-separated evidence-carrying action receipts.
- `src/memory.ts` — independent-task + holdout promotion rule and code-anchor staleness.
- `src/kernel.ts` — minimal execution kernel composing policy, approval, ledger, adapters, verification, and recovery.
- `test/core.test.ts` — six executable invariant checks.
- `test/kernel.integration.test.ts` — two end-to-end crash/recovery checks.
- `test/recovery-matrix.test.ts` — five additional recovery-state tests.
- `benchmark/failure-injection.ts` — deterministic synthetic non-atomic failure harness.

### Real failure-injection experiments

- `experiments/real/browser.ts` — real Chromium + HTTP form side effects through Playwright.
- `experiments/real/desktop.ts` — real X11/Tk GUI actions injected through `xdotool`.
- `experiments/real/desktop-fixture.py` — deterministic native desktop fixture.
- `experiments/real/code.ts` — real isolated Git repository edits and commits.
- `experiments/real/run-all.ts` — aggregate real-surface runner and evidence writer.
- `experiments/real/failure-matrix.ts` — expanded ambiguity/recovery semantics matrix.
- `docs/research/real-failure-injection.md` — real-surface protocol, reproduction, and claim boundary.
- `docs/research/failure-matrix.md` — second-layer failure semantics and latest result table.

The flagship injected failure is identical across surfaces: **the external effect commits, then the dispatcher process is killed before the agent receives completion**. The vanilla baseline blindly retries; LHIC-Core reloads its durable ledger, re-observes the real external state, verifies the postcondition, and avoids duplicate dispatch.

The expanded matrix additionally exercises:

1. pre-dispatch crash / absent effect;
2. delayed visibility requiring a later re-observation;
3. persistent inconclusive observation;
4. duplicate logical delivery after verification;
5. workspace conflict that causes verification failure after the intended effect exists.

### Paper-facing material

- `core/invariants.md` — safety and correctness invariants.
- `docs/research/formal-model.md` — operational model and transition relation.
- `docs/research/ablation-matrix.md` — evaluation variants, failure modes, and metrics.
- `docs/research/evaluation-protocol.md` — controlled and external-validity evaluation protocol.
- `docs/research/current-artifact-results.md` — machine-backed current results and claim boundary.
- `docs/research/code-provenance.md` — mapping from product modules to academic transformations.
- `docs/research/academic-positioning.md` — novelty boundary and research framing.
- `docs/research/references.md` — related-work map and claim discipline.
- `paper/lhic-core-paper.md` — paper draft.

## Run the artifact

Node.js 22.6+ can execute the TypeScript directly using type stripping.

Fast dependency-free checks:

```bash
npm test
npm run bench
```

Current executable checks:

- **13 tests total**: 6 core invariants + 2 kernel crash/recovery integrations + 5 recovery-matrix tests;
- deterministic synthetic trials for fast semantic regression;
- real Chromium / X11 desktop / Git experiments in the integration workflow;
- a five-case expanded recovery-semantics matrix.

### Run the real experiments

Code-only experiment needs Node and Git:

```bash
LHIC_REAL_TRIALS=10 npm run experiment:code
```

Browser experiment uses pinned Playwright + Chromium:

```bash
npm install --no-save --ignore-scripts playwright@1.62.1
npx playwright install --with-deps chromium
LHIC_REAL_TRIALS=10 npm run experiment:browser
```

Desktop experiment on Debian/Ubuntu:

```bash
sudo apt-get install xvfb xauth xdotool python3-tk
LHIC_REAL_TRIALS=10 npm run experiment:desktop
```

Full integration suite:

```bash
LHIC_REAL_TRIALS=10 npm run experiment:real
```

Machine-readable evidence is written to:

```text
artifacts/real-failure-injection-results.json
artifacts/failure-matrix-results.json
```

## Current controlled result

On the current academic artifact, the flagship suite runs 10 trials on each of three real surfaces:

| Surface | Blind-retry duplicate effects | LHIC duplicate effects | LHIC verified recovery |
|---|---:|---:|---:|
| Chromium browser | 10 / 10 | 0 / 10 | 10 / 10 |
| X11/Tk desktop | 10 / 10 | 0 / 10 | 10 / 10 |
| Git/code workspace | 10 / 10 | 0 / 10 | 10 / 10 |
| **Total** | **30 / 30** | **0 / 30** | **30 / 30** |

The expanded semantic matrix currently passes **5 / 5** controlled cases with zero duplicate side effects. See `docs/research/current-artifact-results.md` for exact workflow/artifact identifiers and the narrow interpretation boundary.

These are controlled artifact-validation results. They are **not** official OSWorld, SWE-bench, tau-bench, or other benchmark scores.

## Primary research contributions

1. **Crash-consistent side-effect semantics.** Ambiguous external outcomes become persistent runtime state rather than implicit tool-call failure.
2. **Observe-and-verify-before-replay recovery.** The runtime observes the external world before replaying a possibly committed or unresolved action.
3. **Authority-separated receipts.** Planner, approver, executor, verifier, and evidence remain distinct facts.
4. **Policy-bound execution.** Planner-supplied risk labels may increase effective risk but may never reduce independently inferred risk.
5. **Trust-aware learned behavior.** Reusable behavior requires multiple independent verified tasks plus holdout success.

## Intended claim

The intended claim is not “LHIC is a smarter planner” or “LHIC is universally SOTA.” The intended claim is:

> With the same planner, a deterministic execution kernel with durable side-effect state, independent verification, and authority-aware receipts can reduce duplicate side effects, false completion, and unsafe replay under non-atomic failures.

The real-surface and failure-matrix experiments strengthen internal validity because the side effects cross actual Chromium, native X11/Tk, and Git process/state boundaries and because adjacent ambiguity states are explicitly tested. Publication-level external validity still requires broader real-task distributions, overhead analysis, and official evaluator harnesses.

## Suggested paper title

**LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents**
