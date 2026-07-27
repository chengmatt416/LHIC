# LHIC-LearnLoop — XTF Research Branch

LHIC-LearnLoop keeps the original LHIC thesis intact:

> Predict human intent locally, then execute the matching deterministic action as quickly and accurately as safety allows.

LearnLoop is not a second agent and it is not the execution authority. The existing LHIC predictor always runs first. LearnLoop uses only verifier-backed, externally approved corrections to calibrate that prediction. The Intent Drift gate, adapted from the AI-02 concept, stops execution when the predicted intent changes unexpectedly, oscillates, conflicts with prior corrections, or loses confidence.

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

## Signed production correction ingress

Production correction ingestion is implemented as an explicit opt-in trust boundary. It is disabled unless a separate Ed25519 correction-authority public key is configured through `LHIC_CORRECTION_APPROVAL_PUBLIC_KEY_FILE` or `LHIC_CORRECTION_APPROVAL_PUBLIC_KEY`.

The signing private key is never stored in or exposed to LHIC. A correction approval binds the following values into one short-lived signed claim:

- approval ID and cryptographic nonce;
- hashed approver identity and task identity;
- complete Human Intent fingerprint;
- live normalized-UI fingerprint;
- base and corrected stages;
- training or validation split;
- verifier result hash and verifier version;
- trace SHA-256;
- canonical issue and expiry timestamps.

The Desktop IPC path is exposed only through the existing trusted-renderer handler. Before cryptographic verification, the input is JSON-canonicalized and constrained by byte size, nesting depth, node count, container size, exact envelope keys, full `UserIntent` shape, bounded normalized UI objects, and bounded verifier evidence.

`TrustedHumanIntentCorrectionIngestion` then verifies the Ed25519 signature, expiry, revocation callback, exact task/UI/trace/verifier binding, and current base prediction. It reserves both the approval ID and nonce atomically before mutating LearnLoop. The production file replay store uses private directories, `wx` marker creation, hashed token filenames, restart-persistent reservations, bounded capacity, and delayed cleanup only after the signed approval can no longer be valid. Malformed markers remain fail-closed.

`TaskService` uses the same `DesktopHumanIntentAdmission` instance for execution admission and correction ingestion, so a validated correction cannot be written into an unused parallel LearnLoop. Missing configuration, storage failure, signature failure, stale UI, cross-task substitution, replay, invalid provenance, or verifier failure all reject the correction without enabling execution.

## Safety invariants

- Prediction runs before learning on every request.
- Only externally approved corrections with successful, non-empty verifier evidence are accepted.
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
- Correction approvals are short-lived, signature-bound, and one-time across Desktop restarts.
- Untrusted renderer origins and structurally abusive IPC inputs are rejected before LearnLoop hashing.
- The synthetic benchmark performs zero model calls and zero network calls.

## Reproduce the synthetic mechanism study

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

### Synthetic metrics

- Base top-1 intent accuracy
- Learned top-1 intent accuracy
- Accuracy gain
- Fast Path admission coverage
- Risky misexecution rate
- Correction retention after unrelated learning
- Intent-drift precision, recall, and F1
- p50 and p95 local decision latency

The benchmark has a fixed training set, an independent validation split, and a separate synthetic holdout set. It is a regression and mechanism test, not evidence of performance on arbitrary websites or users.

## Preregistered evidence-study tooling

The branch now includes a separate paired offline study analyzer for the real XTF evidence phase. The tooling is complete; participant recruitment and data collection have **not** been performed.

Freeze and hash a machine-readable plan, including the exact full LHIC Git commit, before collecting any record:

```bash
npm run study:learnloop -- digest \
  --plan benchmarks/learnloop-study/plan.json
```

Before collection, the study kit freezes a restricted task/UI manifest and consented participant enrollment set, then generates a deterministic participant-disjoint schedule. It uses a frozen SHA-256 seed, balances eligible UI variants to a maximum count difference of one, fails when preregistered sample/language/stage minima cannot be met, and emits no gold labels or model outputs in the schedule.

The study kit then finalizes gold labels from blind units using two distinct annotators and mandatory independent adjudication for every disagreement. It reports raw agreement, Fleiss' kappa, label distributions, workloads, and order-independent dataset digests.

A participant-withdrawal command removes all matching blind units plus linked annotations and adjudications into four non-overwritable redacted outputs. Its receipt records before/after digests and invalidates every previously derived record or report, which must be deleted and regenerated.

The tooling enforces before analysis:

Analyze consented JSONL records and write a non-overwritable report:

```bash
npm run study:learnloop -- analyze \
  --plan benchmarks/learnloop-study/plan.json \
  --records results/learnloop-study-records.jsonl \
  --output results/learnloop-study-report.json
```

The analyzer rejects:

- plan substitution or records collected before the frozen timestamp;
- collector-version drift;
- missing consent or retained withdrawn records;
- duplicate evaluation units;
- participant, session, task, or UI-variant overlap between training and evaluation;
- raw extra fields, including accidental raw task or UI content;
- malformed hashes, timestamps, stages, admissions, exclusions, or bounds.

It reports:

- Wilson confidence intervals for accuracy, Fast Path coverage, and wrong-fast admission;
- paired accuracy gain and exact two-sided McNemar/binomial significance;
- expected calibration error;
- fixed-threshold coverage-risk curves;
- p50 and p95 local decision latency;
- English and Taiwan Traditional Chinese strata;
- expected-stage and exclusion counts;
- a plan digest and order-independent dataset digest.

The full protocol, stopping rule, gold-label procedure, claim limits, consent requirements, and separate live-execution follow-up are in `docs/xtf-study-preregistration.md`. `benchmarks/learnloop-study/plan.example.json` is explicitly a template and is not evidence.

## What this branch does not claim

- It does not claim zero vulnerabilities.
- It does not claim clinical, legal, financial, or autonomous high-risk safety.
- It does not claim that synthetic fixtures represent real-world users.
- It does not claim that the preregistered human study has already been conducted.
- It does not claim mechanistic interpretability of a neural model. The AI-02 integration is a behavioral intent-drift microscope: it exposes and tests changes in prediction, confidence, conflicts, candidate eligibility, and oscillation.
- It does not claim that hash-only context is anonymous against every dictionary attack.
- It does not claim that configuring a public key automatically provides a trustworthy correction-authority workflow; deployment still needs protected external signing, identity policy, revocation, audit, and user consent.
- It does not allow LearnLoop to bypass the existing three-run and holdout promotion rules for executable Skills.
- It does not claim the sub-millisecond hosted-runner fixture latency will reproduce on every device.

## Required next evidence for the XTF paper

The protocol and analysis pipeline are now implemented, but the study must still be run with valid consent and realistic non-sensitive tasks. Training and evaluation participants, sessions, tasks, and UI variants must remain disjoint. The frozen report must include confidence intervals, all exclusions, negative results, calibration, selective-risk curves, language strata, and per-domain failures. Do not present the included synthetic percentages or the example plan as general-world evidence.

A separate preregistered live-execution follow-up is still required for verifier-confirmed task success, wrong actions per executed task, bootstrap side effects, confirmation burden, end-to-end latency, recovery after blocks, and user trust.

Before production deployment, define and test the external correction authority: who may sign, how the private key is protected, how user consent is presented, how approvals are revoked, how learned rules and replay markers are deleted, and how audit records are retained without collecting sensitive UI content. The repository verifies signed submissions; it does not operate that organizational trust process.

## Files added or materially integrated by this branch

- `packages/controller/src/human-intent-learnloop.ts`
- `packages/controller/src/human-intent-learnloop.test.ts`
- `packages/controller/src/trusted-correction-ingestion.ts`
- `packages/controller/src/trusted-correction-ingestion.test.ts`
- `packages/controller/src/correction-replay-store.ts`
- `packages/controller/src/correction-replay-store.test.ts`
- `packages/controller/src/prediction-first-human-intent-controller.ts`
- `packages/controller/src/prediction-first-human-intent-controller.test.ts`
- `apps/cli/src/learnloop-benchmark.ts`
- `apps/cli/src/learnloop-benchmark.test.ts`
- `apps/cli/src/learnloop-study.ts`
- `apps/cli/src/learnloop-study.test.ts`
- `apps/cli/src/learnloop-study-labeling.ts`
- `apps/cli/src/learnloop-study-labeling.test.ts`
- `apps/cli/src/learnloop-study-withdrawal.ts`
- `apps/cli/src/learnloop-study-withdrawal.test.ts`
- `apps/cli/src/learnloop-study-schedule.ts`
- `apps/cli/src/learnloop-study-schedule.test.ts`
- `apps/desktop/src/main/prediction-first-browser-admission.ts`
- `apps/desktop/src/main/prediction-first-browser-admission.test.ts`
- `apps/desktop/src/main/correction-ingestion-runtime.ts`
- `apps/desktop/src/main/correction-ingestion-runtime.test.ts`
- `apps/desktop/src/main/correction-submission-validation.ts`
- `apps/desktop/src/main/correction-submission-validation.test.ts`
- `apps/desktop/src/main/desktop-browser-runner.ts`
- `apps/desktop/src/main/task-service.ts`
- `apps/desktop/src/main/task-service-learnloop.test.ts`
- `apps/desktop/src/main/task-service-correction-ingestion.test.ts`
- `benchmarks/learnloop-study/README.md`
- `benchmarks/learnloop-study/plan.example.json`
- `benchmarks/learnloop-study/task-manifest.example.json`
- `benchmarks/learnloop-study/participants.example.jsonl`
- `docs/xtf-study-preregistration.md`
- `docs/xtf-study-operations-sop.md`
- `docs/xtf-study-annotation-rubric.md`
- `docs/xtf-study-consent-template.en.md`
- `docs/xtf-study-consent-template.zh-TW.md`
- `docs/xtf-study-participant-instructions.en.md`
- `docs/xtf-study-participant-instructions.zh-TW.md`
- `.github/workflows/xtf-learnloop.yml`
- `.github/workflows/xtf-study-finalize.yml`
- `XTF-LEARNLOOP.md`
- `docs/xtf-adversarial-review.md`

## Final validation policy

A result is accepted only when the permanent LearnLoop research gate, the permanent study protocol gate, and repository-wide CI all pass on the same non-temporary branch commit. Results from an earlier commit, a skipped step, an `action_required` run, a write-capable formatter, or a diagnostic workflow are supporting evidence only and cannot be reported as the final repository status.
