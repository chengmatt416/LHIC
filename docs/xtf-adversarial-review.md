# LHIC-LearnLoop Adversarial Review

This document records an intentionally hostile review of `xtf/lhic-learnloop`. The standard is not “does the demo work?” It is: could a skeptical XTF judge, security reviewer, reproducibility reviewer, privacy reviewer, or hostile local caller invalidate the central Human Intent claim?

## Scope and non-claim

LHIC remains a prediction-first Human Intent Controller. LearnLoop is an optional local calibration layer used to improve accuracy. The AI-02 integration is a behavioral Intent Drift gate used to detect unstable or contradictory predictions before execution.

No software review can prove that a repository has zero vulnerabilities. “Remediated” means the identified failure mode has a concrete control and regression coverage; it does not mean unknown defects are impossible.

## First hostile-review pass

| Severity | Finding | Why the first version failed strict review | Remediation |
| --- | --- | --- | --- |
| Critical | Unsigned snapshot import | A local attacker or corrupted file could inject an `active` rule and redirect predicted intent. | Removed unsigned import. Added HMAC-SHA-256 envelopes, constant-time verification, schema validation, duplicate rejection, size bounds, and active-conflict checks. |
| Critical | Arbitrary corrected skill name | A caller could bind a corrected intent to an unrelated executable skill. | Removed caller-selected skill names. Skills are derived only from the fixed built-in stage-to-skill map. |
| Critical | No independent validation gate | Repeated labels or duplicated examples could promote poisoned corrections. | Activation requires unique training task hashes and an independent validation UI fingerprint that cannot reuse training evidence. |
| High | Weak correction provenance | A boolean confirmation and arbitrary task ID did not prove independent evidence. | Added task, UI, trace, and verifier fingerprints, bounded verifier version, explicit training/validation split, and duplicate rejection. |
| High | Raw task identifiers persisted | Task IDs could expose user or workflow information. | Rules persist only SHA-256 task hashes; raw goals, labels, selectors, values, evidence, and task IDs are excluded from snapshots. |
| High | UI-ineligible learned target | A historical correction could redirect to a stage unsupported by the current UI. | A rule applies only when the corrected target is a known deterministic stage and remains in the current classifier candidate set. |
| High | No post-learning failure feedback | A bad promoted rule could continue after a verifier failure. | `recordAppliedOutcome` immediately quarantines a responsible rule after a verifier-backed failure. |
| High | Active-rule eviction | Capacity pressure could silently erase trusted corrections. | Automatic eviction is limited to non-active rules; full active capacity fails closed until explicit revocation. |
| High | Benchmark-only controller | A standalone benchmark did not prove the design preserved LHIC routing authority. | Added `PredictionFirstHumanIntentController`, which always runs the base predictor first and delegates final routing to the existing `FastPathRouter`. |
| High | Train/holdout feature leakage | Near-identical fixtures demonstrated bucket memorization rather than useful generalization. | Added layout and role variants, independent validation, a larger synthetic holdout, and explicit non-generalization language. |
| Medium | Ineffective retention test | The unrelated rule never became active, so forgetting was not actually tested. | The benchmark fully trains and validates an unrelated rule before rechecking the original correction. |
| Medium | Trivial drift metric | Perfect F1 from one positive and one negative example had no scientific value. | Expanded drift cases to prediction changes, conflicts, oscillation, and stable controls; report TP, FP, and FN. |
| Medium | Risk counted as drift | Mixing policy risk into drift inflated apparent detector performance. | Risk and approval remain separate admission gates; drift measures behavioral prediction instability only. |
| Medium | Unbounded feature work | Large goals, object arrays, or constraints could cause latency and memory abuse. | Goal scanning, UI objects, feature tokens, rules, sessions, and constraint histograms are bounded. |
| Medium | English-only intent hints | A Taiwan-origin project lacked credible support for its primary local language. | Added Traditional Chinese hints for login, forms, search, download, testing, and verification; full multilingual evaluation remains outstanding. |
| Medium | Fragile microbenchmark threshold | A 5 ms hosted-runner threshold could fail from noise and implied device-independent performance. | The CI regression threshold is 20 ms; the report still exposes p50/p95 and requires separate hardware-specific evidence for XTF claims. |

## Second hostile-review pass

A second pass found three further high-severity issues:

1. **Cross-origin rule bleed.** A correction learned on one origin could match a similar UI elsewhere. Rules are now bound to an exact hashed context scope; raw origins and app names are not persisted.
2. **Mutation before rejected validation.** A rejected validation event could quarantine existing rules before throwing. Rejection checks now occur before state mutation, with a regression test proving state remains unchanged.
3. **Re-signed semantic forgery.** HMAC integrity alone did not reject a semantically invalid rule signed by a compromised trusted process. Snapshot v3 now validates stage transitions, fixed skill binding, bounded tokens, context-key consistency, configured evidence minima, and promotion state before replacing live memory.

## Third hostile-review pass: production execution path

The third pass treated the Desktop application as hostile integration code rather than assuming the research controller would be called correctly.

| Severity | Finding | Attack or invalidating argument | Remediation |
| --- | --- | --- | --- |
| Critical | `TaskService` could bypass LearnLoop | The research module existed, but the production service called `DesktopBrowserRunner.execute()` without an admission callback. A judge could correctly say the demo did not use LearnLoop. | `TaskService.execute()` now supplies a live-UI admission callback only for local deterministic Fast Paths. |
| Critical | Learned intent could substitute a different plan | Matching only the skill name could permit an override to execute different targets or values. | `DesktopHumanIntentAdmission` requires built-in plan source, no missing information, identical skill, and exact ordered fingerprints for every non-navigation action. |
| High | Prediction could occur after mutable actions | Observing the page after fill/click would make the “intent before execution” claim false. | The runner may execute only one fixed low-risk HTTP(S) navigation bootstrap, verify it, capture live UI, and run admission before any fill, press, click, download, or elevated-risk action. |
| High | Admission callback failure could fall through | An exception or malformed decision could allow execution to continue optimistically. | Callback exceptions fail closed, close the browser session, and return terminal `blocked`. |
| High | Blocked task remained replayable | Keeping the pending plan after denial could permit a second execution attempt. | `TaskService` removes `blocked`, `failed`, and `completed` browser plans from pending storage. Regression coverage verifies replay is rejected. |
| High | LearnLoop could elevate Slow Path plans | Passing the same callback to provider-generated plans could convert uncertain proposals into local Fast Paths. | `localHumanIntentAdmission` returns `undefined` whenever `pending.source` exists. Slow Path retains its existing provider and action approval gates. |
| Medium | Bootstrap navigation still changes external state | Even GET-like navigation can trigger tracking, redirects, or server-side effects. | Bootstrap is restricted to the already compiled fixed HTTP(S) target, must be low risk and verifier-backed, and no mutable browser action occurs before admission. Residual network-side effects remain documented. |
| Medium | Evidence could leak task text | Debug evidence could accidentally include the raw goal or query. | Admission evidence reports only stage names, confidence, latency, drift score, rule count, route reason, and plan-match booleans. Regression coverage rejects raw query leakage. |

## CI-derived remediation

Repository-wide checks found defects feature-only tests would have missed:

- Two pre-existing macOS `.app` tests incorrectly expected native registration to succeed on Ubuntu. The runtime restriction was preserved; tests now assert rejection outside macOS and success only on macOS.
- ESLint rejected a control-character regular expression and value imports used only as TypeScript types. The validator now checks code points without disabling `no-control-regex`, and type-only imports are explicit.
- Repository Prettier exposed two runtime files that targeted tests had transpiled successfully. Both were formatted and then revalidated with project typecheck, runtime tests, and lint.
- Temporary diagnostic and write-capable workflows were removed. The final branch retains only the read-only permanent XTF research gate.

## Remaining hard questions

### 1. Is this learning or a rule cache?

It is bounded online calibration over coarse context features, not neural fine-tuning. The contribution should be framed as a safe stability-plasticity mechanism for local intent prediction. Calling it a new model-training method would be misleading.

### 2. Does the synthetic benchmark prove real-world improvement?

No. It proves that the mechanism can improve a fixed synthetic fixture while preserving its encoded safety invariants. It cannot support “50% more accurate on the web” or a population-level accuracy claim. A credible paper needs preregistered tasks, withheld users or sessions, independently authored UI variants, uncertainty intervals, selective-risk curves, and all negative results.

### 3. Can a malicious caller fake confirmation and verifier evidence?

The core validates structure and provenance consistency but does not verify an operating-system approval signature. Automatic production correction ingestion must remain disabled until a trusted adapter binds the signed approval, verifier result, task identity, UI fingerprint, trace fingerprint, and verifier version. Direct exposure of `recordCorrection` to untrusted callers would be unsafe.

### 4. Are hashed features anonymous?

No. Hashes reduce accidental disclosure but are not anonymity. Low-entropy values can be guessed. Persistent deployments should use encrypted storage, OS-keyring or KMS-held HMAC keys, retention limits, and user-visible deletion/revocation controls.

### 5. Does the drift gate explain model internals?

No. It explains observable behavior: base prediction, learned override, confidence change, conflict, candidate eligibility, and oscillation. It must not be marketed as neural mechanistic interpretability.

### 6. Can LearnLoop increase selective risk?

Yes. Any mechanism that admits more tasks to Fast Path can increase the absolute count of wrong fast executions even when average accuracy improves. Real evaluation must report wrong executions per admitted task, coverage-risk curves, and abstention quality—not only top-1 accuracy.

### 7. Is the navigation bootstrap truly side-effect free?

Not provably. Opening a URL can create analytics events, redirects, sessions, or server-side work. The design prevents mutable browser controls before admission, but not all network-side effects. High-risk or state-changing entry URLs should remain ineligible for this local Fast Path.

### 8. Is correction ingestion end to end?

No. Execution admission is integrated; automatic ingestion of new corrections is still a deliberate trust-boundary gap. This is the most important remaining production security task.

## Final acceptance gates

The branch is repository-complete only when all of the following pass at the same final commit:

- repository formatting;
- TypeScript project references;
- full TypeScript suite;
- lint;
- package build and internal benchmark;
- LearnLoop benchmark without model or network calls;
- system preflight;
- production dependency audit at high severity;
- documentation links, release-version checks, and secret scan;
- AgentLab and game-training Python checks;
- container production preflight;
- Linux, macOS, and Windows package smoke and desktop packaging;
- permanent XTF research gate, including Desktop admission and `TaskService` boundary tests.

The pull request must remain draft if any required gate is red, queued, skipped because an earlier step failed, or unavailable.

## Strict rating framework after remediation

| Dimension | Initial | Current code-level rating | Why it is not higher |
| --- | ---: | ---: | --- |
| Human Intent focus | 7/10 | 10/10 | The base predictor is explicitly first; LearnLoop is calibration only; execution requires authoritative exact-plan reproduction. |
| Security architecture | 5/10 | 8.5/10 | Major injection, persistence, plan-substitution, replay, and Slow Path elevation paths are controlled; signed correction ingestion is unfinished. |
| Privacy | 5/10 | 8/10 | Raw task/UI values are excluded from learned snapshots, but hashes are guessable and runtime retention policy needs user-study validation. |
| Continual-learning stability | 4/10 | 8.5/10 | Independent validation, conflicts, failure feedback, revocation, scope binding, and no active eviction are present; long-duration real-user behavior is untested. |
| Intent-drift quality | 3/10 | 7/10 | Signals and fail-closed behavior are explicit, but the labeled drift dataset is synthetic and small. |
| Speed evidence | 5/10 | 7/10 | Local decision p50/p95 are measured and very small in the fixture; cross-device, cold-start, energy, and full-task latency are missing. |
| Scientific rigor | 4/10 | 6.5/10 | The mechanism study is reproducible and honestly bounded; real users, confidence intervals, calibration, and independent task authorship are absent. |
| Reproducibility | 5/10 | 9/10 | Fixed fixtures, immutable JSON, CLI reproduction, targeted gate, and repository-wide CI are present. |
| Real-world evidence | 2/10 | 3.5/10 | Production admission is integrated, but no preregistered realistic-task study has been run. |
| XTF submission readiness | 4/10 | 7/10 | Strong code and research foundation; the paper-quality human study and signed correction-ingestion adapter remain blockers. |

A green CI result raises confidence that the implementation is internally consistent. It does not raise the real-world evidence score by itself.
