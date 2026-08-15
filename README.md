# LHIC-Core Academic Artifact

**Crash-consistent, evidence-carrying execution for autonomous agents.**

This branch is the academic-facing artifact for LHIC-Core. It intentionally narrows the product branch into a research problem: how can an AI agent execute real computer actions while preserving authority separation, postcondition verification, durable side-effect recovery, and trust-aware learning?

## Research thesis

Modern agents are good at proposing tool calls, but a tool-call result is not proof that the intended external state changed safely. Real environments are non-atomic: a process can crash after dispatch, a UI can change between observation and action, a tool can timeout after the side effect occurred, and a model can understate the risk of its own proposed action.

LHIC-Core treats agent execution as a monitored runtime problem rather than a model-quality problem.

```text
agent plan / human intent
        |
        v
policy + authority check
        |
        v
approval scope + action hash
        |
        v
durable side-effect ledger
        |
        v
local execution adapter
        |
        v
postcondition verifier
        |
        v
evidence-carrying receipt
        |
        v
trusted memory / recovery state
```

## Academic code artifact

This branch includes a minimal TypeScript reference model under `core/`. It is not the full product runtime; it is a small, auditable implementation of the research contract selected and adapted from the `feature/sota-improvements` design.

Run the artifact with:

```bash
npm install
npm run typecheck
npm test
```

## Repository map

- `core/lhic-core-model.ts` — reference implementation for classification, approval validation, side-effect ledger recovery, receipts, memory promotion, and reliability metrics.
- `tests/lhic-core-model.test.ts` — invariant tests for the academic kernel.
- `core/invariants.md` — core safety and correctness invariants.
- `docs/research/academic-positioning.md` — problem framing, novelty, and related-work positioning.
- `docs/research/evaluation-protocol.md` — proposed failure-injection and ablation protocol.
- `docs/research/code-artifact.md` — what was selected and changed from the product branch.
- `docs/research/paper-outline.md` — paper-facing outline.

## What this branch is not

- Not a claim that LHIC is universally SOTA.
- Not a model benchmark leaderboard submission by itself.
- Not a product installer branch.
- Not a claim that OMP-native tool success equals LHIC verification.
- Not a replacement for official OSWorld, SWE-bench, or tau-bench evaluator output.

## Minimal evaluation claim

The intended claim is not “a smarter agent.” The intended claim is:

> Under non-atomic failures and adversarial planning errors, an execution kernel with durable side-effect state, independent verification, and authority-aware receipts reduces duplicate side effects, false completion, and unsafe replay compared with a vanilla tool-calling loop using the same planner.
