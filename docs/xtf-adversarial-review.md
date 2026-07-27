# LHIC-LearnLoop Adversarial Review

This document records an intentionally hostile review of `xtf/lhic-learnloop`. The standard is not “does the demo work?” It is: could a skeptical XTF judge, security reviewer, reproducibility reviewer, privacy reviewer, or hostile local caller invalidate the central Human Intent claim?

## Scope and non-claim

LHIC remains a prediction-first Human Intent Controller. LearnLoop is an optional local calibration layer used to improve accuracy. The AI-02 integration is a behavioral Intent Drift gate used to detect unstable or contradictory predictions before execution.

No software review can prove that a repository has zero vulnerabilities. “Remediated” means the identified failure mode has a concrete control and regression coverage; it does not mean unknown defects are impossible.

## First hostile-review pass

| Severity | Finding                           | Why the first version failed strict review                                                       | Remediation                                                                                                                                                         |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Unsigned snapshot import          | A local attacker or corrupted file could inject an `active` rule and redirect predicted intent.  | Removed unsigned import. Added HMAC-SHA-256 envelopes, constant-time verification, schema validation, duplicate rejection, size bounds, and active-conflict checks. |
| Critical | Arbitrary corrected skill name    | A caller could bind a corrected intent to an unrelated executable skill.                         | Removed caller-selected skill names. Skills are derived only from the fixed built-in stage-to-skill map.                                                            |
| Critical | No independent validation gate    | Repeated labels or duplicated examples could promote poisoned corrections.                       | Activation requires unique training task hashes and an independent validation UI fingerprint that cannot reuse training evidence.                                   |
| High     | Weak correction provenance        | A boolean confirmation and arbitrary task ID did not prove independent evidence.                 | Added task, UI, trace, and verifier fingerprints, bounded verifier version, explicit training/validation split, and duplicate rejection.                            |
| High     | Raw task identifiers persisted    | Task IDs could expose user or workflow information.                                              | Rules persist only SHA-256 task hashes; raw goals, labels, selectors, values, evidence, and task IDs are excluded from snapshots.                                   |
| High     | UI-ineligible learned target      | A historical correction could redirect to a stage unsupported by the current UI.                 | A rule applies only when the corrected target is a known deterministic stage and remains in the current classifier candidate set.                                   |
| High     | No post-learning failure feedback | A bad promoted rule could continue after a verifier failure.                                     | `recordAppliedOutcome` immediately quarantines a responsible rule after a verifier-backed failure.                                                                  |
| High     | Active-rule eviction              | Capacity pressure could silently erase trusted corrections.                                      | Automatic eviction is limited to non-active rules; full active capacity fails closed until explicit revocation.                                                     |
| High     | Benchmark-only controller         | A standalone benchmark did not prove the design preserved LHIC routing authority.                | Added `PredictionFirstHumanIntentController`, which always runs the base predictor first and delegates final routing to the existing `FastPathRouter`.              |
| High     | Train/holdout feature leakage     | Near-identical fixtures demonstrated bucket memorization rather than useful generalization.      | Added layout and role variants, independent validation, a larger synthetic holdout, and explicit non-generalization language.                                       |
| Medium   | Ineffective retention test        | The unrelated rule never became active, so forgetting was not actually tested.                   | The benchmark fully trains and validates an unrelated rule before rechecking the original correction.                                                               |
| Medium   | Trivial drift metric              | Perfect F1 from one positive and one negative example had no scientific value.                   | Expanded drift cases to prediction changes, conflicts, oscillation, and stable controls; report TP, FP, and FN.                                                     |
| Medium   | Risk counted as drift             | Mixing policy risk into drift inflated apparent detector performance.                            | Risk and approval remain separate admission gates; drift measures behavioral prediction instability only.                                                           |
| Medium   | Unbounded feature work            | Large goals, object arrays, or constraints could cause latency and memory abuse.                 | Goal scanning, UI objects, feature tokens, rules, sessions, and constraint histograms are bounded.                                                                  |
| Medium   | English-only intent hints         | A Taiwan-origin project lacked credible support for its primary local language.                  | Added Traditional Chinese hints for login, forms, search, download, testing, and verification; full multilingual evaluation remains outstanding.                    |
| Medium   | Fragile microbenchmark threshold  | A 5 ms hosted-runner threshold could fail from noise and implied device-independent performance. | The CI regression threshold is 20 ms; the report still exposes p50/p95 and requires separate hardware-specific evidence for XTF claims.                             |

## Second hostile-review pass

1. **Cross-origin rule bleed.** Rules are now bound to an exact hashed context scope; raw origins and app names are not persisted.
2. **Mutation before rejected validation.** Rejection checks now occur before state mutation, with a regression test proving state remains unchanged.
3. **Re-signed semantic forgery.** Snapshot v3 validates stage transitions, fixed skill binding, bounded tokens, context-key consistency, configured evidence minima, and promotion state before replacing live memory.

## Third hostile-review pass: production execution path

| Severity | Finding                                           | Attack or invalidating argument                                                                                                                                                            | Remediation                                                                                                                                                                                                 |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | `TaskService` could bypass LearnLoop              | The research module existed, but the production service called `DesktopBrowserRunner.execute()` without an admission callback. A judge could correctly say the demo did not use LearnLoop. | `TaskService.execute()` now supplies a live-UI admission callback only for local deterministic Fast Paths.                                                                                                  |
| Critical | Learned intent could substitute a different plan  | Matching only the skill name could permit an override to execute different targets or values.                                                                                              | Admission requires built-in plan source, no missing information, identical skill, and exact ordered fingerprints for every non-navigation action.                                                           |
| High     | Prediction could occur after mutable actions      | Observing the page after fill/click would make the “intent before execution” claim false.                                                                                                  | The runner may execute only one fixed low-risk HTTP(S) navigation bootstrap, verify it, capture live UI, and run admission before any mutable action.                                                       |
| High     | Admission callback failure could fall through     | An exception or malformed decision could allow execution to continue optimistically.                                                                                                       | Callback exceptions fail closed, close the browser session, and return terminal `blocked`.                                                                                                                  |
| High     | Blocked task remained replayable                  | Keeping the pending plan after denial could permit a second execution attempt.                                                                                                             | `TaskService` removes `blocked`, `failed`, and `completed` browser plans from pending storage. Regression coverage verifies replay is rejected.                                                             |
| High     | LearnLoop could elevate Slow Path plans           | Passing the same callback to provider-generated plans could convert uncertain proposals into local Fast Paths.                                                                             | Slow Path plans receive no LearnLoop admission callback and retain their provider and action-approval gates.                                                                                                |
| Medium   | Bootstrap navigation still changes external state | Even GET-like navigation can trigger tracking, redirects, or server-side effects.                                                                                                          | Bootstrap is restricted to the compiled fixed HTTP(S) target, must be low risk and verifier-backed, and no mutable browser action occurs before admission. Residual network-side effects remain documented. |
| Medium   | Evidence could leak task text                     | Debug evidence could accidentally include the raw goal or query.                                                                                                                           | Admission evidence reports only stage names, confidence, latency, drift score, rule count, route reason, and plan-match booleans.                                                                           |

## Fourth hostile-review pass: signed correction ingestion

| Severity | Finding                                     | Attack or invalidating argument                                                                                                               | Remediation                                                                                                                                                                                                           |
| -------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Plain `confirmedByUser` boolean             | Any local caller could claim the user approved a correction.                                                                                  | Added short-lived Ed25519 correction approvals bound to approver hash, task hash, intent, UI fingerprint, trace, verifier result/version, stages, and evidence split.                                                 |
| Critical | Correction written into an unused LearnLoop | A secure ingestion module could mutate a separate memory instance while production admission continued using another.                         | `TaskService` points execution admission and correction ingestion at the same `DesktopHumanIntentAdmission` instance.                                                                                                 |
| Critical | Replay protection lost after restart        | An in-memory consumed-token set allowed the same signed correction after restarting Desktop.                                                  | Added an explicit replay-store interface and production file store with atomic `wx` approval and nonce markers, private permissions, hashed filenames, and cross-restart tests.                                       |
| High     | Cross-task or stale-UI substitution         | A valid signature could be paired with a different task, UI, trace, result, or verifier.                                                      | Every signed claim field is recomputed from the submitted binding and compared before mutation; current base prediction must also match the signed predicted stage.                                                   |
| High     | Untrusted renderer could call ingestion     | A compromised or foreign Electron frame could invoke a privileged IPC method.                                                                 | All handlers, including correction ingress, pass through `registerSecureIpcHandler`, which rejects renderer URLs outside the configured trusted policy.                                                               |
| High     | Structurally abusive IPC payload            | Deep or malformed JSON could trigger recursive hashing, memory pressure, or type confusion before signature rejection.                        | IPC input is JSON-cloned and bounded by 512 KiB, nesting depth, node count, container size, exact envelope keys, complete `UserIntent` shape, UI object fields, timestamp, and verifier evidence.                     |
| High     | Public-key symlink / replacement race       | A configured key path could be swapped between metadata check and read.                                                                       | POSIX opens with `O_NOFOLLOW`; all platforms read through a file descriptor after `fstat`, regular-file and size validation, plus device/inode equality against the initial metadata.                                 |
| High     | Replay store permanent capacity exhaustion  | Never deleting expired markers eventually disabled all future learning.                                                                       | Valid markers are retained through approval expiry plus a safety window, then approval and nonce directories are pruned together. Malformed markers remain fail-closed.                                               |
| Medium   | Same key used for action and learning       | A compromised action-approval authority should not automatically gain the ability to alter learned intent.                                    | Correction ingress uses separate `LHIC_CORRECTION_APPROVAL_PUBLIC_KEY[_FILE]` configuration. The correction private key never enters LHIC.                                                                            |
| Medium   | No authority configured                     | A default-open implementation could silently accept unsigned local corrections.                                                               | No correction public key means ingestion is disabled; the admission method throws `not configured`.                                                                                                                   |
| Medium   | Signing workflow mistaken for completed UX  | Cryptographic verification alone does not establish consent presentation, organizational identity policy, revocation operations, or auditing. | The repository exposes an opt-in verification boundary only. External signer operations, user consent UX, revocation service, deletion controls, and privacy-preserving audit remain explicit deployment obligations. |

## Fifth hostile-review pass: evidence methodology

| Severity | Finding                                      | Attack or invalidating argument                                                                                                             | Remediation                                                                                                                                                                                                                                        |
| -------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Post-hoc thresholds                          | Choosing sample size, success thresholds, or exclusions after seeing outcomes can manufacture a winning result.                             | Added a machine-readable plan with a canonical freeze timestamp, exact schema, immutable digest command, fixed thresholds, language minima, stopping rule, and non-overwritable report. Records must bind to the frozen digest.                    |
| Critical | Training/evaluation identity leakage         | Reusing a participant, session, task, or UI variant can convert memorization into apparent generalization.                                  | The analyzer rejects overlap across all four hashed dimensions. The confirmatory protocol requires participant-disjoint evaluation, not merely different task IDs.                                                                                 |
| High     | Raw participant or task data in study files  | A convenient JSONL collector could leak names, goals, URLs, screenshots, or UI text.                                                        | Study records use exact-key validation and accept only secret-salted hashes plus bounded decision metrics. Raw extra fields cause failure; the aggregate report declares that raw task and UI text were not collected.                             |
| High     | Perfect zero-error result presented as proof | Reporting `0/N` wrong-fast outcomes without uncertainty hides severe small-sample risk.                                                     | The report includes Wilson confidence intervals and gates on the upper bound, not the observed point estimate. A regression test proves that zero errors in ten units still fails a 10% upper-bound criterion.                                     |
| High     | Unpaired significance or cherry-picked cases | Comparing aggregate percentages without paired discordance ignores task difficulty; searching thresholds inflates significance.             | The fixed paired offline design reports exact two-sided McNemar/binomial significance and fixed confidence-threshold coverage-risk curves. Additional subgroup or threshold analyses are explicitly exploratory unless separately preregistered.   |
| High     | Exclusions silently erase failures           | Deleting technical failures or protocol deviations after observing outcomes can bias the report.                                            | Allowed exclusion codes are schema-frozen; excluded units remain in the dataset digest and disposition counts. Withdrawn records are rejected and must be deleted to honor withdrawal rather than being relabeled as ordinary exclusions.          |
| High     | Gold labels copied from LearnLoop            | Treating the correction itself as the expected label makes accuracy circular.                                                               | The protocol requires blinded independent annotators, preregistered adjudication, and a frozen expected-stage label before paired analysis.                                                                                                        |
| Medium   | Aggregate result hides language failure      | A strong English result could conceal weak Taiwan Traditional Chinese performance.                                                          | Plans preregister required language tags and minimum units per language; reports include per-language counts, base and learned accuracy, and gain.                                                                                                 |
| Medium   | Offline prediction confused with execution   | A paired frozen-observation study does not measure browser side effects, verifier success, confirmation burden, or real end-to-end latency. | The report contains this limitation, and the protocol requires a separate randomized live-execution follow-up. A passing offline report cannot be marketed as proof of side-effect-free autonomous execution.                                      |
| Medium   | Example plan presented as completed evidence | A committed sample plan and passing analyzer tests could be shown as though participants had been studied.                                  | The template is named `example-not-preregistered`; documentation repeatedly states that tooling is complete but recruitment and data collection have not occurred. CI validates only schema and CLI reproducibility, not real-world effectiveness. |

## CI-derived remediation

Repository-wide checks found defects feature-only tests would have missed:

- Two pre-existing macOS `.app` tests incorrectly expected native registration to succeed on Ubuntu. The runtime restriction was preserved; tests now assert rejection outside macOS and success only on macOS.
- ESLint rejected a control-character regular expression and value imports used only as TypeScript types. The validator now checks code points without disabling `no-control-regex`, and type-only imports are explicit.
- Repository Prettier exposed runtime and research files that targeted tests had transpiled successfully. They were formatted and revalidated with project typecheck, tests, and lint.
- Dependency audit identified a native transformer-to-image-processing chain with unpatched high-severity advisories. The default embedding path is now bounded dependency-free local feature hashing; production high/critical advisories are zero.
- A temporary formatter used to normalize the study files was replaced by a permanent read-only protocol gate. The final branch has no workflow with repository write permission.

## Remaining hard questions

### 1. Is this learning or a rule cache?

It is bounded online calibration over coarse context features, not neural fine-tuning. The contribution should be framed as a safe stability-plasticity mechanism for local intent prediction. Calling it a new model-training method would be misleading.

### 2. Does the synthetic benchmark prove real-world improvement?

No. It proves that the mechanism can improve a fixed synthetic fixture while preserving its encoded safety invariants. It cannot support “50% more accurate on the web” or a population-level accuracy claim. The new preregistration tooling makes a credible study possible; it does not replace participants, realistic tasks, consent, independent labels, or negative results.

### 3. Is correction ingestion now end to end?

The repository path is end to end from trusted renderer IPC through structural validation, signature verification, persistent one-time reservation, current-prediction verification, and mutation of the same production LearnLoop. However, the external signing authority is not an organizational product: identity proofing, consent UI, private-key custody, revocation distribution, audit policy, and rule-deletion UX remain deployment responsibilities. It would be misleading to call the entire human approval lifecycle complete.

### 4. Are hashed features anonymous?

No. Hashes reduce accidental disclosure but are not anonymity. Low-entropy values can be guessed. Study identifiers require a study-specific secret salt; persistent deployments should use encrypted storage, OS-keyring or KMS-held keys, retention limits, and user-visible deletion/revocation controls.

### 5. Does the drift gate explain model internals?

No. It explains observable behavior: base prediction, learned override, confidence change, conflict, candidate eligibility, and oscillation. It must not be marketed as neural mechanistic interpretability.

### 6. Can LearnLoop increase selective risk?

Yes. Any mechanism that admits more tasks to Fast Path can increase the absolute count of wrong fast executions even when average accuracy improves. The study analyzer reports wrong-fast outcomes per admitted task, Wilson uncertainty, fixed coverage-risk curves, and abstention coverage rather than only top-1 accuracy.

### 7. Is the navigation bootstrap truly side-effect free?

Not provably. Opening a URL can create analytics events, redirects, sessions, or server-side work. The design prevents mutable browser controls before admission, but not all network-side effects. High-risk or state-changing entry URLs should remain ineligible for this local Fast Path.

### 8. Can local malware still submit a valid correction?

Possession of the external correction-authority private key remains decisive. LHIC prevents unsigned, replayed, substituted, stale, malformed, and foreign-renderer submissions; it cannot protect a signer private key that has already been stolen. Key custody and revocation are part of the deployment threat model.

### 9. Is the XTF evidence study complete?

No. The protocol, schemas, CLI, statistical analysis, privacy bounds, leakage checks, and immutable reporting path are implemented. No participant-level study result exists yet. Scientific rigor rises because the future analysis is constrained before data collection; real-world evidence does not rise until the preregistered study is actually conducted and all outcomes are retained.

## Final acceptance gates

The branch is repository-complete only when all of the following pass at the same final commit:

- repository formatting;
- TypeScript project references;
- full TypeScript suite;
- lint;
- package build and internal benchmark;
- LearnLoop benchmark without model or network calls;
- preregistration parser, leakage controls, statistical analysis, and public CLI digest tests;
- system preflight;
- production dependency audit at high severity;
- documentation links, release-version checks, and secret scan;
- AgentLab and game-training Python checks;
- container production preflight;
- Linux, macOS, and Windows package smoke and Desktop packaging;
- permanent read-only LearnLoop research gate;
- permanent read-only study protocol gate.

The pull request must remain draft if any required gate is red, queued, skipped because an earlier step failed, or unavailable.

## Strict rating framework after remediation

| Dimension                    | Initial | Current code-level rating | Why it is not higher                                                                                                                                                             |
| ---------------------------- | ------: | ------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Human Intent focus           |    7/10 |                     10/10 | The base predictor is explicitly first; LearnLoop is calibration only; execution requires authoritative exact-plan reproduction.                                                 |
| Security architecture        |    5/10 |                      9/10 | Signed bound corrections, persistent replay, exact-plan routing, Slow Path isolation, bounded IPC, and key-file hardening are present; signer operations remain.                 |
| Privacy                      |    5/10 |                    8.5/10 | Raw values are excluded from learned snapshots and study records; hashes remain guessable, and deployment consent/deletion/retention operations are incomplete.                  |
| Continual-learning stability |    4/10 |                    8.5/10 | Independent validation, conflicts, failure feedback, revocation, scope binding, and no active eviction are present; long-duration real-user behavior is untested.                |
| Intent-drift quality         |    3/10 |                      7/10 | Signals and fail-closed behavior are explicit, but the labeled drift dataset is synthetic and small.                                                                             |
| Speed evidence               |    5/10 |                      7/10 | Local decision p50/p95 are measured and the future protocol freezes latency criteria; cross-device, cold-start, energy, and end-to-end evidence are still missing.               |
| Scientific rigor             |    4/10 |                    7.5/10 | Preregistration, immutable digests, exact paired testing, uncertainty, calibration, exclusions, and leakage controls are implemented; no human data has been collected.          |
| Reproducibility              |    5/10 |                    9.5/10 | Fixed fixtures, immutable reports, machine-readable plans, dataset digests, CLI reproduction, two read-only gates, and repository-wide CI are present.                           |
| Real-world evidence          |    2/10 |                    3.5/10 | Production execution and correction ingress are integrated, but the preregistered realistic-task study and separate live-execution study have not been run.                      |
| XTF submission readiness     |    4/10 |                      8/10 | The engineering and study machinery are strong; valid participant evidence, annotation results, live-execution evidence, and operational signer/consent workflow remain missing. |

A green CI result raises confidence that the implementation and analysis machinery are internally consistent. It does not raise the real-world evidence score by itself.
