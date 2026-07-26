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
User goal + normalized live UI state
                 |
                 v
          Existing predictIntent
                 |
                 v
      Base intent + confidence
                 |
                 v
    LearnLoop bounded calibration
                 |
                 v
   Intent Drift gate (AI-02 layer)
                 |
        +--------+----------------+
        |                         |
        v                         v
 blocked / confirm      existing FastPathRouter
                                  |
                                  v
                    exact deterministic plan match
                                  |
                                  v
                     existing executor + verifier
```

The final `FastPathRouter`, action risk evaluator, approval verifier, replay protection, and execution verifier remain authoritative. `HumanIntentLearnLoop` only returns an admission recommendation and an adjusted known stage; it never executes or invents an action.

## Production Desktop integration

`PredictionFirstHumanIntentController` is exported from `@lhic/controller`. The Desktop path integrates it through `DesktopHumanIntentAdmission`:

1. `TaskService` may compile a deterministic local Fast Path candidate without a model call.
2. `DesktopBrowserRunner` opens only the plan's first fixed, low-risk HTTP(S) navigation step.
3. That navigation must pass the existing verifier and produce non-empty evidence.
4. `BrowserStateObserver` captures the live normalized UI.
5. The existing predictor runs first; LearnLoop may then calibrate the known intent, and the AI-02 drift gate evaluates behavioral change.
6. The authoritative `FastPathRouter` must select `fast`, use a built-in plan, report no missing information, reproduce the same skill, and reproduce the exact non-navigation action sequence.
7. Only then may fill, press, click, download, or elevated-risk steps continue through the existing execution and verification gates.

Admission fails closed. A thrown callback, ambiguous UI, drift detection, low confidence, plan-source mismatch, skill mismatch, or action mismatch closes the browser session and records a terminal `blocked` result. A blocked plan is removed from the pending-task store and cannot be executed again.

Slow Path browser plans deliberately receive no LearnLoop admission callback. LearnLoop therefore cannot promote a provider-generated plan or convert a Slow Path proposal into a Fast Path execution.

## Correction-ingestion boundary

Runtime **execution admission is integrated**. Automatic production ingestion of new LearnLoop corrections is intentionally not enabled yet.

`recordCorrection` must only be called after the existing signed user-approval record and verifier result have both been validated and bound to the same task, UI fingerprint, verifier version, and trace fingerprint. The core module checks bounded structure and provenance consistency, but it is not itself the operating-system signature verifier. Until that adapter is implemented and tested end to end, real corrections should be imported only through a trusted local research workflow.

## Safety invariants

- Prediction runs before learning on every request.
- Only user-confirmed corrections with successful, non-empty verifier evidence are accepted.
- Training evidence and independent validation evidence cannot reuse the same UI fingerprint.
- A learned rule cannot change `riskLevel`, `requiresConfirmation`, action policy, approval state, or verifier requirements.
- High-risk and unknown-risk intents always require confirmation.
- Conflicting corrections are quarantined rather than resolved by recency.
- A verifier-backed failed applied outcome immediately quarantines the responsible rule.
- Learned rules are bounded, revocable, local, and scoped to a hashed browser origin or bounded non-browser app/screen context.
- Context memory stores hashes and coarse semantic features, not the raw goal, UI text, credentials, origin, app name, or constraint values.
- Imported snapshots must pass both HMAC integrity verification and semantic validation of scope, stage-to-skill binding, feature bounds, evidence minima, and promotion state.
- Active rules are not silently evicted to make room for new learning.
- The Desktop Fast Path requires the authoritative router to reproduce the exact deterministic plan before mutable actions.
- Slow Path plans cannot receive LearnLoop Fast Path admission.
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

The benchmark has a fixed training set, an independent validation split, and a separate synthetic holdout set. It is a regression and mechanism test, not evidence of performance on arbitrary websites or users.

## What this branch does not claim

- It does not claim zero vulnerabilities.
- It does not claim clinical, legal, financial, or autonomous high-risk safety.
- It does not claim that synthetic fixtures represent real-world users.
- It does not claim mechanistic interpretability of a neural model. The AI-02 integration is a behavioral intent-drift microscope: it exposes and tests changes in prediction, confidence, conflicts, candidate eligibility, and oscillation.
- It does not claim that hash-only context is anonymous against every dictionary attack.
- It does not claim that automatic production correction ingestion is complete.
- It does not allow LearnLoop to bypass the existing three-run and holdout promotion rules for executable Skills.
- It does not claim the sub-millisecond hosted-runner fixture latency will reproduce on every device.

## Required next evidence for the XTF paper

Before submission, the synthetic regression must be supplemented with a preregistered, consented study using realistic but non-sensitive tasks. Training and evaluation users, UI variants, and task IDs should be separated. Report confidence intervals, all exclusions, negative results, calibration curves, selective-risk curves, and per-domain failure cases. Do not present the included fixture percentages as general-world performance.

Before enabling autonomous correction ingestion, implement a trusted adapter that binds `confirmedByUser`, signed approval records, verifier evidence, verifier version, UI fingerprint, and trace fingerprint to one task. Test replay, cross-task substitution, revoked approval, stale UI, and post-execution verifier failure.

## Files added or materially integrated by this branch

- `packages/controller/src/human-intent-learnloop.ts`
- `packages/controller/src/human-intent-learnloop.test.ts`
- `packages/controller/src/prediction-first-human-intent-controller.ts`
- `packages/controller/src/prediction-first-human-intent-controller.test.ts`
- `apps/cli/src/learnloop-benchmark.ts`
- `apps/cli/src/learnloop-benchmark.test.ts`
- `apps/desktop/src/main/prediction-first-browser-admission.ts`
- `apps/desktop/src/main/prediction-first-browser-admission.test.ts`
- `apps/desktop/src/main/desktop-browser-runner.ts`
- `apps/desktop/src/main/task-service.ts`
- `apps/desktop/src/main/task-service-learnloop.test.ts`
- `.github/workflows/xtf-learnloop.yml`
- `XTF-LEARNLOOP.md`
- `docs/xtf-adversarial-review.md`

## Final validation policy

A result is accepted only when the dedicated LearnLoop research gate and the repository-wide CI both pass on the same non-temporary branch commit. Results from an earlier commit, a skipped step, an `action_required` run, or a diagnostic workflow are supporting evidence only and cannot be reported as the final repository status.
