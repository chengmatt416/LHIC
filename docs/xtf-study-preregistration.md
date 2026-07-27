# LHIC-LearnLoop XTF Study Preregistration Protocol

This document defines the evidence protocol for evaluating whether LHIC-LearnLoop improves **Human Intent prediction and safe Fast Path admission**. It is a study specification, not a claim that the study has already been run.

The protocol intentionally separates three questions:

1. Does LearnLoop improve top-1 Human Intent prediction on withheld people, sessions, tasks, and UI variants?
2. Does the improvement preserve selective safety, calibration, and low local decision latency?
3. Does the production system execute safely in a live browser?

The first two questions use the paired offline protocol implemented by `lhic study learnloop`. The third requires a separately approved live-execution study; offline prediction results must not be presented as proof of side-effect-free browser execution.

## 1. Primary research question

> On preregistered, consented, non-sensitive evaluation tasks that are disjoint from all LearnLoop training evidence, does prediction-first LearnLoop increase top-1 Human Intent accuracy without exceeding a preregistered upper confidence bound on wrong Fast Path admission?

## 2. Confirmatory hypotheses

### H1 — Accuracy

LearnLoop top-1 accuracy will exceed the uncalibrated base predictor by at least the preregistered minimum accuracy gain.

### H2 — Paired improvement

Among evaluation units where the two systems disagree, the count of `base wrong / learned correct` units will exceed `base correct / learned wrong` units with a two-sided exact McNemar/binomial p-value at or below the preregistered alpha.

### H3 — Selective safety

The upper Wilson confidence bound for LearnLoop wrong Fast Path admission rate will not exceed the preregistered maximum.

A wrong Fast Path admission means:

- admission is `execute_fast`; and
- the predicted Human Intent stage differs from the independently assigned expected stage.

This is an offline selective-risk measure. It is not identical to an observed harmful browser execution.

### H4 — Calibration

LearnLoop expected calibration error will not exceed the preregistered maximum.

### H5 — Latency

LearnLoop local decision p95 latency will not exceed the preregistered maximum on the frozen study runtime.

## 3. Study design

The implemented design is:

```text
paired-offline-intent-v1
```

Each evaluation unit contains the base and LearnLoop decisions for the same frozen normalized UI observation and Human Intent input. Pairing reduces task-difficulty noise and permits exact discordance analysis.

This design must not execute both arms against a mutable external account. The paired study should operate on frozen, consented, non-sensitive observations or deterministic local fixtures derived from the study task.

## 4. Preregistration and freeze procedure

Before collecting any record:

1. Copy the plan example and replace every study-specific value.
2. Pin the LHIC Git revision and the study collector version outside the dataset.
3. Set hypotheses, sample minimums, languages, calibration bins, confidence level, exclusion rules, and pass thresholds.
4. Set `frozenAt` to a canonical UTC ISO timestamp.
5. Commit the plan to a public or access-controlled append-only location.
6. Run:

```bash
lhic study learnloop digest --plan benchmarks/learnloop-study/plan.json
```

7. Publish or timestamp the returned plan SHA-256 before collection.
8. Bind every study record to that exact digest.

Changing the plan after collection begins creates a new study and requires a new `studyId`, freeze timestamp, and digest. Do not silently replace the old plan.

## 5. Required separation

The analyzer rejects any overlap between training and evaluation for all four dimensions:

- participant hash;
- session hash;
- task hash;
- UI-variant hash.

Hashes must be lowercase SHA-256 digests generated with a study-specific secret salt held outside the repository. Unsalted hashes of names, emails, school IDs, or low-entropy task labels are not acceptable pseudonymization.

The strict participant-disjoint rule means LearnLoop evidence may not be trained on a participant who later appears in the confirmatory evaluation set. A separate exploratory within-person study may be run, but it must not be mixed into this confirmatory report.

## 6. Participants and consent

Use only participants able to provide valid consent under the applicable school, competition, and local research rules. Because the project owner is a minor, an adult supervisor or institution should review participant-facing materials and data handling before recruitment.

Each retained record must assert:

```json
{
  "consented": true,
  "withdrawn": false
}
```

A withdrawn participant's records must be deleted before analysis. The analyzer rejects records marked withdrawn rather than counting them as ordinary exclusions.

Participant-facing consent should explain:

- the purpose of intent-prediction research;
- what is recorded and what is not recorded;
- that no passwords, private messages, raw goals, or raw UI text should enter the study file;
- withdrawal and deletion procedures;
- foreseeable risks;
- whether compensation is offered;
- who can access the data;
- retention and publication policy.

## 7. Task and UI construction

Use realistic but non-sensitive tasks covering at least the preregistered number of distinct expected stages. Recommended stages include:

- login;
- form filling;
- search;
- download;
- test/verification flow.

For each task family, independently author evaluation UI variants after the training variants have been frozen. Variants should alter layout, object ordering, labels, distractors, and benign page structure without changing the underlying intended action.

Do not construct evaluation variants by making trivial string substitutions to the training fixture. Record the independently assigned task and UI-variant hashes before running either arm.

## 8. Language strata

At minimum, the XTF study should preregister English and Taiwan Traditional Chinese:

```json
"requiredLanguages": ["en", "zh-TW"]
```

The plan also freezes `minimumEvaluationUnitsPerLanguage`. A language does not count as covered merely because one example is present.

Report each language stratum separately, including sample count, base accuracy, learned accuracy, and accuracy gain. Do not hide a negative language result inside an aggregate improvement.

## 9. Data minimization

The JSONL study file accepts only the fixed record schema. It deliberately excludes:

- participant names or contact details;
- raw user goals;
- raw UI text;
- selectors;
- credentials;
- URLs or origins;
- screenshots;
- verifier evidence text;
- correction approval signatures or private keys.

Every top-level and nested object uses exact-key validation. Extra fields cause analysis to fail.

The report contains only aggregate metrics plus plan and dataset digests. Hashes reduce accidental disclosure but are not anonymity; use secret-salted identifiers, encrypted storage, limited retention, and controlled access.

## 10. Record format

Store one JSON object per line. Required fields are:

```text
schemaVersion
planSha256
split
participantHash
sessionHash
taskHash
uiVariantHash
language
recordedAt
collectorVersion
consented
withdrawn
exclusionCode
expectedStage
base
learned
```

Each arm contains exactly:

```text
predictedStage
confidence
admission
latencyMs
```

Allowed exclusion codes are frozen by schema:

- `none`;
- `technical_failure`;
- `protocol_deviation`.

Excluded units remain in the dataset digest and disposition counts, preventing silent deletion after outcomes are observed. A withdrawal is different: withdrawal requires deletion.

## 11. Gold-label procedure

Expected Human Intent stage labels should be assigned independently of LHIC predictions. Recommended procedure:

1. Two annotators independently label the intended stage from the participant instruction and frozen task definition.
2. Annotators must not see base or LearnLoop predictions.
3. Resolve disagreement using a preregistered adjudicator.
4. Report initial agreement and adjudication count outside the machine-readable analyzer report.
5. Freeze the final expected-stage label before running the paired analysis.

Do not use the LearnLoop correction itself as the only gold label.

## 12. Primary analysis

Run:

```bash
lhic study learnloop analyze \
  --plan benchmarks/learnloop-study/plan.json \
  --records results/learnloop-study-records.jsonl \
  --output results/learnloop-study-report.json
```

The output path uses exclusive creation and will not overwrite an earlier report.

The analyzer computes:

- base and learned top-1 accuracy;
- Wilson confidence intervals;
- paired accuracy gain;
- exact two-sided McNemar/binomial p-value;
- Fast Path coverage and confidence intervals;
- wrong Fast Path admission rate and Wilson interval;
- expected calibration error;
- p50 and p95 local decision latency;
- coverage-risk curves at fixed confidence thresholds;
- per-language results;
- expected-stage counts;
- exclusion disposition counts;
- order-independent dataset SHA-256.

The command exits non-zero if any preregistered pass criterion fails. A failed result is still a valid scientific result and must be retained and reported.

## 13. Stopping rule and exclusions

Recruit and collect until the preregistered minimum number of included evaluation units is reached. Do not stop early because results become significant or because accuracy reaches a desired value.

Permitted machine-readable exclusions are limited to the schema codes. Document every exclusion decision before examining aggregate arm differences whenever possible.

If a protocol defect requires a new exclusion rule, freeze an amended exploratory analysis separately. Do not relabel it as the original confirmatory analysis.

## 14. Multiple comparisons

The pass/fail decision is based only on the preregistered criteria in the plan. Additional subgroup, threshold, or task-family analyses are exploratory unless separately preregistered.

Do not search many thresholds and report only the most favorable result. The analyzer uses fixed coverage-risk thresholds.

## 15. Required reporting

Publish or submit:

- the frozen plan and its digest;
- LHIC commit SHA;
- collector version;
- dataset digest;
- immutable report;
- aggregate exclusion counts;
- participant and task recruitment procedure;
- annotation procedure and agreement;
- all negative outcomes and protocol deviations;
- hardware and operating-system details for latency claims;
- explicit statement that the paired study does not measure external side effects.

Raw participant-level records should be shared only when consent, policy, and privacy protections permit it. A digest and independently reproducible aggregate report may be preferable.

## 16. Separate live-execution follow-up

A later live study is still required to measure:

- verifier-confirmed task success;
- wrong actions per executed task;
- side effects from bootstrap navigation;
- confirmation burden;
- end-to-end completion latency;
- recovery after blocked or drifted intent;
- user trust and willingness to use the system.

That study should randomize by participant or session to avoid running two mutable arms against the same external state. It needs its own preregistration and must not reuse the paired offline report schema as if it were live evidence.

## 17. Claims permitted after this study

A passing report may support a bounded statement such as:

> In a preregistered paired offline evaluation with disjoint participants, sessions, tasks, and UI variants, LHIC-LearnLoop improved Human Intent top-1 accuracy while satisfying the preregistered selective-risk, calibration, and local-latency criteria.

It does not support claims that:

- arbitrary websites are handled correctly;
- real browser execution is side-effect free;
- accuracy is universally 100%;
- all languages or user populations are covered;
- the system has zero vulnerabilities;
- LearnLoop performs neural self-training.
