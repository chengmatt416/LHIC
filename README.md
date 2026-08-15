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
                                        | absent  -> safe retry path
                                        | unclear -> needs_resolution
```

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
- `src/recovery.ts` — verify/observe-before-retry recovery semantics.
- `src/receipt.ts` — authority-separated evidence-carrying action receipts.
- `src/memory.ts` — independent-task + holdout promotion rule and code-anchor staleness.
- `src/kernel.ts` — minimal execution kernel composing policy, approval, ledger, adapters, verification, and recovery.
- `test/core.test.ts` — executable checks for the core invariants.
- `benchmark/failure-injection.ts` — deterministic synthetic non-atomic failure harness.

### Paper-facing material

- `core/invariants.md` — safety and correctness invariants.
- `docs/research/formal-model.md` — operational model and transition relation.
- `docs/research/ablation-matrix.md` — evaluation variants, failure modes, and metrics.
- `docs/research/evaluation-protocol.md` — planned controlled and external-validity evaluation.
- `docs/research/current-artifact-results.md` — reproducible sanity-check output from the current reference harness.
- `docs/research/code-provenance.md` — mapping from product modules to academic transformations.
- `docs/research/academic-positioning.md` — novelty boundary and research framing.
- `docs/research/references.md` — related-work map and claim discipline.
- `paper/lhic-core-paper.md` — pre-results paper draft.

## Run the artifact

Node.js 22.6+ can execute the TypeScript directly using type stripping. There are no third-party runtime dependencies.

```bash
npm test
npm run bench
```

The benchmark is a **controlled synthetic failure-injection harness**, not an official OSWorld, SWE-bench, or tau-bench score.

Current reference checks:

- 6 invariant tests, expected `6 passed / 0 failed`;
- 100 deterministic synthetic trials per runtime strategy;
- current synthetic harness demonstrates the intended safety/availability trade-off and is recorded in `docs/research/current-artifact-results.md`.

## Primary research contributions

1. **Crash-consistent side-effect semantics.** Ambiguous external outcomes become persistent runtime state rather than implicit tool-call failure.
2. **Verify-before-retry recovery.** The runtime observes the external world before replaying a possibly committed action.
3. **Authority-separated receipts.** Planner, approver, executor, verifier, and evidence remain distinct facts.
4. **Policy-bound execution.** Planner-supplied risk labels may increase effective risk but may never reduce independently inferred risk.
5. **Trust-aware learned behavior.** Reusable behavior requires multiple independent verified tasks plus holdout success.

## Intended claim

The intended claim is not “LHIC is a smarter planner” or “LHIC is universally SOTA.” The intended claim is:

> With the same planner, a deterministic execution kernel with durable side-effect state, independent verification, and authority-aware receipts can reduce duplicate side effects, false completion, and unsafe replay under non-atomic failures.

The synthetic harness is internal-validity evidence only. Real-world publication claims require repeated experiments on real browser/desktop/coding adapters and external benchmark harnesses.

## Suggested paper title

**LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents**
