# XTF LearnLoop human-study operations SOP

Status: execution template only. This document is not ethics approval, legal advice, proof of consent, or evidence that a study was conducted.

Because the project owner is a minor, an adult supervisor or institution must review recruitment, consent, storage, withdrawal, incident handling, compensation, and publication before any participant is enrolled.

## 1. Roles and separation of access

Use separate people or accounts for these roles wherever practicable:

| Role | May access | Must not access before label freeze |
| --- | --- | --- |
| Study supervisor | protocol, consent process, incident log, retention policy | participant secrets unless required for safeguarding |
| Coordinator | restricted task manifest, participant pseudonyms, randomization schedule | model outcome summaries before enrollment and assignment freeze |
| Collector operator | one current assignment, consent state, local collector | gold label and annotator identity |
| Annotator A/B | blinded unit packet and rubric | participant hash, split, base prediction, learned prediction, confidence, admission |
| Adjudicator | disputed blinded unit packet, both proposed labels, rubric | participant hash and model-arm outputs |
| Analyst | finalized records, frozen plan, labeling report | direct identifiers or recruitment contact list |

A field such as `blindedToArm: true` records a claim made by the workflow. It does not independently prove that the person was operationally blinded.

## 2. Before recruitment

1. Obtain adult or institutional review appropriate to the setting.
2. Finalize the English and Taiwan Traditional Chinese participant materials.
3. Freeze the machine-readable study plan and exact LHIC commit SHA.
4. Compute and record the plan digest.
5. Independently author training and evaluation task/UI materials.
6. Compute task and UI-variant SHA-256 digests from canonical, versioned material packages.
7. Complete the restricted task manifest, including the fixed randomization seed and gold stage for each task family.
8. Commit or otherwise trusted-timestamp the plan, manifest, rubric, consent version, and task-material digests before outcomes are inspected.
9. Prepare encrypted storage and a separate contact-to-participant-code mapping. Never store participant names or contact details in the JSONL research dataset.
10. Test withdrawal and incident procedures on synthetic data.

## 3. Enrollment

1. Present the approved information sheet in a language the participant understands.
2. Record consent, and assent/guardian permission when required by the applicable rules.
3. Assign a random internal participant code.
4. Derive `participantHash` with a study-specific secret salt held outside the dataset.
5. Assign exactly one preregistered split and language stratum. A participant must never appear in both training and evaluation.
6. Write one exact-schema participant enrollment row only after valid consent.
7. Do not enroll a withdrawn participant or silently reassign a participant after outcomes are known.

## 4. Freeze the deterministic schedule

Run:

```bash
lhic study learnloop schedule \
  --plan benchmarks/learnloop-study/plan.json \
  --manifest benchmarks/learnloop-study/task-manifest.json \
  --participants results/participants.jsonl \
  --output results/schedule.json
```

The generator:

- binds the manifest to the frozen plan digest;
- rejects participant, task, and UI-variant identity reuse;
- requires consented, non-withdrawn participant rows;
- deterministically orders tasks from the frozen SHA-256 seed;
- balances UI variants with a maximum count difference of one;
- fails when total or per-language evaluation minima cannot be met;
- writes a non-overwritable coordinator schedule without gold labels or model outputs.

Record the manifest, participant-dataset, assignment-dataset, and schedule file digests before collecting outcomes. The schedule contains participant pseudonyms and must not be distributed to annotators.

## 5. Participant session

1. Confirm the participant still wishes to continue.
2. Open only the next coordinator-assigned task/UI variant.
3. Do not request real credentials, private messages, financial details, medical details, or other sensitive data.
4. Use synthetic or study-provided values only.
5. Collect the base and LearnLoop decisions on the same frozen observation.
6. Record only the exact schema: salted hashes, bounded metrics, timestamps, consent state, exclusion code, and arm decisions.
7. Do not collect raw task text, raw UI text, screenshots, URLs, selectors, passwords, free-form notes, or contact details in the analysis dataset.
8. Log technical incidents separately without copying participant content.

## 6. Blinded labeling

1. Generate annotator packets from blind units after collection.
2. Replace participant/session/task/UI identifiers with only the blind unit hash needed for labeling.
3. Randomize packet order separately for each annotator.
4. Require two different annotators per unit.
5. Do not reveal either model arm, confidence, admission, correction, or split.
6. Require an independent adjudicator for every disagreement and prohibit adjudication when the two labels agree.
7. Finalize labels only with the repository command after all rows pass exact-schema validation.

## 7. Exclusions and incidents

Only use preregistered exclusion codes. Technical failures and protocol deviations remain in the dataset digest and disposition counts. Do not delete a failed unit because it harms the result.

Pause collection and notify the supervisor when any of the following occurs:

- sensitive information is accidentally captured;
- a participant reports distress or misunderstanding;
- task material performs a real external side effect;
- blinding is broken;
- participant/task/UI split leakage is discovered;
- the collector, model, or protocol version changes;
- stored data or a signing key may have been exposed.

Document the decision to resume, amend, or terminate. A protocol amendment after data inspection must be versioned and reported; it must not be represented as the original confirmatory analysis.

## 8. Withdrawal

1. Authenticate the request using the separately stored contact mapping.
2. Stop future sessions immediately.
3. Run the withdrawal command against blind units, annotations, and adjudications.
4. Securely delete or replace the original source files, backups under project control, prior finalized records, labeling reports, analysis reports, and exported artifacts.
5. Regenerate labels and analysis from the redacted replacements.
6. Record the receipt and deletion actions in the restricted operations log.
7. Do not claim secure erasure merely because a redacted replacement file was produced.

## 9. Analysis and publication

1. Analyze only after the plan, manifest, schedule, collection, and gold labels are frozen.
2. Report every preregistered outcome, language stratum, exclusion, failure, and negative result.
3. Report confidence intervals and the exact paired significance result, not only point estimates.
4. Separate offline intent-prediction claims from live browser execution claims.
5. Publish only aggregate results and non-sensitive reproducibility materials.
6. Never publish participant hashes, the secret salt, contact mapping, restricted coordinator schedule, or raw study files.

## 10. Retention and deletion checklist

The supervisor must set concrete dates before recruitment for:

- contact mapping deletion;
- raw blind-unit deletion;
- annotation/adjudication deletion;
- finalized-record deletion;
- encrypted backup expiration;
- withdrawal receipt retention;
- aggregate report retention;
- repository and artifact access review.

Record who performed each deletion, when it occurred, which storage locations were checked, and which backups remain outside project control. A local receipt is not a trusted timestamp or external audit signature.
