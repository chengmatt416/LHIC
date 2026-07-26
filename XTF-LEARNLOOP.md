# LHIC-LearnLoop — XTF Research Branch

LHIC-LearnLoop keeps the original LHIC thesis intact:

> Predict human intent locally, then execute the matching deterministic action as quickly and accurately as safety allows.

LearnLoop is not a second agent and it is not the execution authority. The existing LHIC predictor always runs first. LearnLoop uses only verifier-backed, user-confirmed corrections to calibrate that prediction. The Intent Drift gate, adapted from the AI-02 concept, stops execution when the predicted intent changes unexpectedly, oscillates, conflicts with prior corrections, or loses confidence.

This work is isolated on `xtf/lhic-learnloop`. It does not change `main` until separately reviewed and merged.

## Research question

Can a bounded local correction loop increase top-1 human-intent prediction accuracy and Fast Path coverage without increasing risky misexecution, weakening approval policy, or causing catastrophic forgetting?

## Hypotheses

1. Repeated, independently verified corrections will improve intent classification on unseen task variants.
2. LearnLoop will add less than 5 ms p95 decision overhead in the included deterministic fixture.
3. A drift gate will identify prediction changes and conflicting corrections before execution.
4. Learning unrelated intents will not erase previously active corrections in the included retention test.
5. Learned memory will never lower risk, skip confirmation, generate an action, or call a model.

## Prediction-first architecture

```text
User goal + normalized UI state
             |
             v
      Existing predictIntent
             |
             v
  Base intent + confidence + evidence
             |
             v
 LearnLoop bounded calibration (optional)
             |
             v
 Intent Drift gate (AI-02 integration)
             |
       +-----+------------------+
       |                        |
       v                        v
confirm / Slow Path      existing FastPathRouter
                                |
                                v
                    deterministic skill + verifier
```

The final `FastPathRouter`, action risk evaluator, approval verifier, replay protection, and execution verifier remain authoritative. `HumanIntentLearnLoop` only returns an admission recommendation and an adjusted known stage; it does not execute anything.

## Current integration boundary

`PredictionFirstHumanIntentController` is exported from `@lhic/controller` and is exercised by the dedicated benchmark and invariant tests. It combines the existing predictor, optional LearnLoop calibration, the AI-02 drift gate, `FastPathRouter`, and Fast Path plan resolution.

The production Desktop `TaskService` is **not yet LearnLoop-aware**. It attempts to compile a local plan before a live normalized UI state has been observed, while the research controller requires both the human goal and current UI state. A production integration must therefore occur after browser observation and must obtain correction confirmation and verifier provenance from LHIC's existing signed approval and verification path. The branch does not claim that desktop task execution currently uses LearnLoop.

## Safety invariants

- Prediction runs before learning on every request.
- Only user-confirmed corrections with successful, non-empty verifier evidence are accepted.
- A learned rule cannot change `riskLevel`, `requiresConfirmation`, action policy, approval state, or verifier requirements.
- High-risk and unknown-risk intents always require confirmation.
- Conflicting corrections are quarantined rather than resolved by recency.
- Learned rules are bounded, revocable, local, and scoped to a hashed browser origin or bounded non-browser app/screen context.
- Context memory stores hashes and coarse semantic features, not the raw goal, UI text, credentials, origin, app name, or constraint values.
- Imported snapshots must pass both HMAC integrity verification and semantic validation of scope, stage-to-skill binding, feature bounds, and promotion evidence.
- The Fast Path still requires a known deterministic skill and the existing confidence threshold.
- The benchmark performs zero model calls and zero network calls.

## Reproduce the included study

Requirements are the same as the repository: Node.js 24 and npm 11.

```bash
npm ci
npm run typecheck
npm test
npm run bench:learnloop
```

Write the immutable JSON result to a new file:

```bash
npm run bench:learnloop -- --output artifacts/learnloop-report.json
```

The output command uses exclusive creation and refuses to overwrite an existing result.

## Included metrics

- Base top-1 intent accuracy
- Learned top-1 intent accuracy
- Accuracy gain
- Fast Path admission coverage
- Risky misexecution rate
- Correction retention after unrelated learning
- Intent-drift precision, recall, and F1
- p50 and p95 local decision latency

The benchmark has a fixed training set and a separate synthetic holdout set. It is a regression and mechanism test, not evidence of performance on arbitrary websites or users.

## What this branch does not claim

- It does not claim zero vulnerabilities.
- It does not claim clinical, legal, financial, or autonomous high-risk safety.
- It does not claim that synthetic fixtures represent real-world users.
- It does not claim mechanistic interpretability of a neural model. The AI-02 integration is a behavioral intent-drift microscope: it exposes and tests changes in prediction, confidence, conflicts, and oscillation.
- It does not claim that hash-only context is anonymous against every dictionary attack.
- It does not claim that the current Desktop `TaskService` is LearnLoop-integrated.
- It does not allow LearnLoop to bypass the existing three-run and holdout promotion rules for executable Skills.

## Required next evidence for the XTF paper

Before submission, the synthetic regression must be supplemented with a preregistered, consented study using realistic but non-sensitive tasks. Training and evaluation users, UI variants, and task IDs should be separated. Report confidence intervals, all exclusions, negative results, calibration curves, and per-domain failure cases. Do not present the included fixture percentages as general-world performance.

Before presenting a desktop end-to-end demo as research evidence, wire the research controller after live UI observation, bind `confirmedByUser` and verifier evidence to the existing signed runtime records, and test that failures feed back into rule quarantine without weakening any execution gate.

## Files added by this branch

- `packages/controller/src/human-intent-learnloop.ts`
- `packages/controller/src/human-intent-learnloop.test.ts`
- `packages/controller/src/prediction-first-human-intent-controller.ts`
- `packages/controller/src/prediction-first-human-intent-controller.test.ts`
- `apps/cli/src/learnloop-benchmark.ts`
- `apps/cli/src/learnloop-benchmark.test.ts`
- `.github/workflows/xtf-learnloop.yml`
- `XTF-LEARNLOOP.md`
- `docs/xtf-adversarial-review.md`
