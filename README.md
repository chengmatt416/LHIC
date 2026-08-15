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

## Academic scope

This branch contains the academic core specification, reference model, invariants, and evaluation protocol. Product layers such as installers, Electron packaging, Appwrite deployment, release marketing, and provider-specific branding are excluded from the research question.

The relevant core ideas are:

1. **Authority separation** — planner, approver, executor, and verifier are distinct roles.
2. **Crash-consistent side-effect ledger** — ambiguous outcomes are recovered by observation, not blind retry.
3. **Evidence-carrying receipts** — execution, verification, risk, approval, and provenance remain separate facts.
4. **Policy-bound execution** — the planner cannot lower independently inferred risk.
5. **Trust-aware learned behavior** — skills and recipes require verifier-backed evidence, independence, and staleness checks.
6. **Workspace state mediation** — concurrent coding agents receive stale-read/conflict signals before unsafe writes.

## What this branch is not

- Not a claim that LHIC is universally SOTA.
- Not a model benchmark leaderboard submission by itself.
- Not a product installer branch.
- Not a claim that OMP-native tool success equals LHIC verification.
- Not a replacement for official OSWorld, SWE-bench, or tau-bench evaluator output.

## Suggested paper title

**LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents**

## Suggested paper contributions

- A formal execution model for non-atomic agent side effects.
- A durable ledger protocol that distinguishes proposed, approved, possibly committed, executed, verified, and needs-resolution states.
- Authority-aware receipts that prevent planner success, executor success, and verifier evidence from being collapsed into one boolean.
- A failure-injection benchmark measuring duplicate side effects, false success, recovery, and unauthorized action rates.
- A trust-aware learning rule for promoting repeated verified behavior into reusable capabilities.

## Repository map

- `core/lhic-core-model.ts` — academic reference types for the execution kernel.
- `core/invariants.md` — core safety and correctness invariants.
- `docs/research/academic-positioning.md` — problem framing, novelty, and related-work positioning.
- `docs/research/evaluation-protocol.md` — proposed failure-injection and ablation protocol.
- `docs/research/artifact-scope.md` — what is included/excluded from the academic artifact.

## Minimal evaluation claim

The intended claim is not “a smarter agent.” The intended claim is:

> Under non-atomic failures and adversarial planning errors, an execution kernel with durable side-effect state, independent verification, and authority-aware receipts reduces duplicate side effects, false completion, and unsafe replay compared with a vanilla tool-calling loop using the same planner.
