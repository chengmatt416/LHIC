# LHIC-LearnLoop Adversarial Review

This document records the review of the first XTF implementation on `xtf/lhic-learnloop`. It is intentionally harsher than a normal code review. The standard used here is: could a skeptical XTF judge, security reviewer, reproducibility reviewer, or hostile local caller invalidate the central claim?

## Scope and non-claim

LHIC remains a prediction-first Human Intent Controller. LearnLoop is an optional local calibration layer. The AI-02 integration is a behavioral Intent Drift gate, not a claim of neural mechanistic interpretability.

No software review can prove that a repository has zero vulnerabilities. The final status below means that identified issues were remediated and automated checks passed at the recorded commit; it does not mean unknown defects are impossible.

## First implementation review

| Severity | Finding                                            | Why the first version failed a strict review                                                                                                  | Remediation                                                                                                                                                                                                                                                                 |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical | Unsigned snapshot import                           | A local attacker or corrupted file could inject an `active` rule and redirect predicted intent.                                               | Removed unsigned import. Added HMAC-SHA-256 export/import with constant-time verification, schema validation, duplicate rejection, size bounds, and active-conflict checks.                                                                                                 |
| Critical | Arbitrary corrected skill name                     | The caller could provide a skill name unrelated to the corrected stage, violating the claim that learning cannot create execution capability. | Removed caller-selected skill names. Skills are derived only from the fixed built-in stage-to-skill map.                                                                                                                                                                    |
| Critical | No independent validation gate                     | Distinct task labels alone could promote a poisoned correction.                                                                               | Activation now requires three unique training task hashes and an independent validation UI fingerprint. Validation cannot create a rule and cannot reuse a training UI fingerprint.                                                                                         |
| High     | Provenance fields were weak                        | A boolean `confirmedByUser` and arbitrary task IDs were not enough to demonstrate independent evidence.                                       | Added SHA-256 UI and trace fingerprints, bounded verifier version, explicit training/validation split, and duplicate evidence rejection. The runtime adapter remains responsible for verifying the underlying signed approval and verifier result before calling LearnLoop. |
| High     | Raw task IDs persisted                             | Task identifiers could contain user or workflow information.                                                                                  | Rules retain only SHA-256 task hashes. Raw goals, labels, selectors, constraint values, verifier evidence, and task IDs are not stored in the snapshot.                                                                                                                     |
| High     | Learned target could be absent from the current UI | A historical rule might redirect to a stage unsupported by current observations.                                                              | A rule applies only when its target is both a known deterministic LHIC stage and present in the current classifier candidate set. Otherwise it is ignored and exposed as a drift signal.                                                                                    |
| High     | Post-learning failures did not feed back           | A promoted rule could continue being used after an observed verifier failure.                                                                 | Added `recordAppliedOutcome`; one verifier-backed failure immediately quarantines the rule.                                                                                                                                                                                 |
| High     | Active rules could be silently evicted             | Capacity pressure could cause hidden catastrophic forgetting.                                                                                 | Automatic eviction is limited to non-active rules. If capacity is filled by active rules, new learning fails closed until explicit revocation.                                                                                                                              |
| High     | LearnLoop was not wired to the routing facade      | A benchmark-only module would not establish that the design fits LHIC execution.                                                              | Added `PredictionFirstHumanIntentController`, which calls the base predictor first, applies LearnLoop, then delegates plans and final safety decisions to the existing `FastPathRouter`.                                                                                    |
| High     | Train and holdout fixtures were nearly identical   | Changing only a URL while ignoring URLs in features demonstrated bucket memorization, not robust generalization.                              | Added layout and role variants, a separate safety-validation split, a larger evaluation holdout, and explicit disclosure that the benchmark remains synthetic.                                                                                                              |
| Medium   | Retention test was ineffective                     | The “unrelated correction” never became active, so it did not test forgetting.                                                                | The benchmark now fully trains and validates an unrelated form rule before re-testing the original search correction.                                                                                                                                                       |
| Medium   | Drift F1 used one positive and one negative        | A perfect score from two examples had no scientific value.                                                                                    | Expanded the drift set to prediction-change, conflict, oscillation, and five stable controls; the report includes TP, FP, and FN counts.                                                                                                                                    |
| Medium   | Risk was mixed into the drift score                | That inflated drift detection by counting known safety policy as model drift.                                                                 | Risk remains a separate admission gate. Drift now measures prediction change, correction conflict, target ineligibility, confidence drop, oscillation, and unresolved intent.                                                                                               |
| Medium   | Unbounded input work                               | Very large goals, object arrays, or nested constraints could increase latency.                                                                | Goal scanning is capped, UI objects are capped, only enumerated semantic hints and a bounded constraint-type histogram are retained, rules and sessions are bounded.                                                                                                        |
| Medium   | English-only intent hints                          | A Taiwan-origin project would be poorly justified if its core heuristic ignored Taiwan Chinese.                                               | Added Traditional Chinese hints for login, forms, search, download, testing, and verification. This is still not a complete multilingual evaluation.                                                                                                                        |
| Medium   | A 5 ms CI threshold was fragile                    | Hosted-runner load can make microbenchmarks flaky and the result is not device-independent.                                                   | Latency remains reported; the regression threshold is 20 ms. XTF claims must report hardware, warm-up, repeated trials, and confidence intervals separately.                                                                                                                |

## Remaining hard questions after remediation

### 1. Is this actually learning or a rule cache?

It is bounded online calibration over coarse context features, not neural fine-tuning. That is acceptable only if the paper states it plainly. The scientific contribution must be framed as a safe stability-plasticity mechanism for local intent prediction, not as a new foundation model.

### 2. Does the included benchmark prove real-world improvement?

No. It is a deterministic regression benchmark designed to test mechanisms and safety invariants. It cannot support a claim such as “LHIC becomes 50% more accurate on the web.” A real submission needs preregistered tasks, withheld users or sessions, UI variants not authored after seeing failures, uncertainty intervals, and all negative results.

### 3. Can a malicious local caller fake confirmation and verifier evidence?

The core module validates structure and provenance fingerprints but does not itself verify an operating-system approval signature or re-run a verifier. That trust boundary belongs to the existing LHIC approval and verifier layers. Production wiring must call `recordCorrection` only after those layers succeed. A direct untrusted API exposure would be unsafe.

### 4. Are hashed features anonymous?

No. Hashing coarse feature tokens and task IDs reduces accidental disclosure but is not a formal anonymity guarantee. Low-entropy values can be guessed. Persistent deployments should protect the database with existing LHIC encryption and keep snapshot HMAC keys in the OS keyring or an approved KMS.

### 5. Does the drift gate explain the model internally?

No. It explains observable behavioral change: base prediction, learned override, confidence, conflicts, candidate eligibility, and recent oscillation. Calling this mechanistic interpretability would be misleading.

### 6. Could the learned rule increase Fast Path risk?

It can increase Fast Path coverage by raising a validated candidate above the prediction threshold. It cannot lower declared risk, skip confirmation, create an action, or bypass `FastPathRouter`. Nevertheless, every real deployment must measure selective risk: wrong Fast Path executions per admitted task, not just total accuracy.

## Final acceptance gates

The branch is acceptable for continued XTF experimentation only when all of the following are true at the same commit:

- repository formatting passes;
- TypeScript project references compile;
- the full TypeScript test suite passes;
- lint passes;
- package build and package smoke tests pass;
- internal LHIC benchmark still passes;
- LearnLoop benchmark passes without model or network calls;
- production dependency audit has no high-severity finding;
- documentation links, release versions, and secret scan pass;
- container preflight and macOS, Windows, and Linux package smoke jobs pass.

The pull request must remain a draft if any gate is red, queued, skipped because of an earlier failure, or unavailable.

## Final review rating framework

| Dimension                    | Initial | Target after remediation | Reason                                                                                                         |
| ---------------------------- | ------: | -----------------------: | -------------------------------------------------------------------------------------------------------------- |
| Human Intent focus           |    7/10 |                    10/10 | Prediction is explicitly first and the routing facade preserves LHIC's main thesis.                            |
| Scientific rigor             |    4/10 |                     7/10 | Mechanism benchmark improved, but real user evidence and statistical uncertainty are still missing.            |
| Security architecture        |    5/10 |                     8/10 | Major injection and persistence paths are gated; trust-boundary integration still requires care.               |
| Privacy                      |    5/10 |                     8/10 | Raw values are not persisted; hashes are not anonymity.                                                        |
| Continual-learning stability |    4/10 |                     8/10 | Independent validation, conflict quarantine, failure feedback, revocation, and no active eviction are present. |
| Intent-drift quality         |    3/10 |                     7/10 | Behavioral signals are explicit and tested, but the dataset remains synthetic and small.                       |
| Speed evidence               |    5/10 |                     7/10 | Local p50/p95 are measured; cross-device and energy evidence are not yet collected.                            |
| Reproducibility              |    5/10 |                     9/10 | One command, fixed fixtures, machine-readable report, and CI gates are included.                               |
| XTF submission readiness     |    4/10 |                     7/10 | Strong repo foundation; paper-quality real-world experiment remains unfinished.                                |

The final score must be updated from actual CI and benchmark results, not assumed from the implementation.

## Second hostile-review pass

A second independent pass found three additional high-severity issues:

1. **Cross-origin rule bleed:** a correction learned on one browser origin could match a similar UI on another origin. Rules are now bound to an exact SHA-256 context scope; raw origins and app names are not persisted.
2. **Mutation before rejected validation:** an invalid conflicting validation event could quarantine existing rules before throwing. Quarantine now occurs only after validation-only rejection checks complete, and a regression test proves rejected calls leave state unchanged.
3. **Re-signed semantic forgery:** HMAC integrity alone did not reject an active rule with insufficient evidence or a stage-to-skill mismatch when the envelope was re-signed by a compromised or misconfigured trusted process. Import now validates stage transitions, fixed skill binding, bounded tokens, context-key consistency, and configured evidence minima before replacing live state.

The signed snapshot schema is now v3 and rejects missing or inconsistent scope bindings. Older research snapshots are not silently trusted.

## CI-derived remediation pass

The repository-wide checks exposed issues that the feature-only tests would not have found:

- Two pre-existing tests required a macOS `.app` target to register successfully on an Ubuntu runner. The runtime restriction was preserved; the tests now assert rejection outside macOS and success only on macOS.
- ESLint rejected a control-character regular expression and two value imports used only as TypeScript types. The validator now checks Unicode code points without disabling `no-control-regex`, and the facade uses explicit type-only imports.
- The full TypeScript suite reached 390/390 passing tests before lint remediation. The dedicated LearnLoop gate independently passed formatting, typecheck, all three LearnLoop/facade/benchmark test files, and immutable benchmark generation.

This section is deliberately evidence-oriented: a final all-green repository CI run is still required at the same final commit before the branch can be called repository-complete.
