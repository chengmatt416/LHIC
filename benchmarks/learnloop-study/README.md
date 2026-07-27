# LearnLoop preregistered study tools

This directory contains the machine-readable starting point for the XTF evidence study. Files named `example` are templates only and are not experimental evidence.

## Workflow

1. Copy `plan.example.json` to a new study-specific plan.
2. Replace the example identifiers, exact LHIC commit SHA, collector version, timestamp, sample minimums, languages, and thresholds.
3. Commit and timestamp the plan before collecting records.
4. Compute the frozen digest:

```bash
lhic study learnloop digest --plan benchmarks/learnloop-study/plan.json
```

5. Copy `task-manifest.example.json` and `participants.example.jsonl`, replace every placeholder, freeze the restricted manifest and consented participant enrollment set, and generate the deterministic balanced schedule:

```bash
lhic study learnloop schedule \
  --plan benchmarks/learnloop-study/plan.json \
  --manifest benchmarks/learnloop-study/task-manifest.json \
  --participants results/participants.jsonl \
  --output results/schedule.json
```

The manifest contains gold stages and remains restricted to the coordinator. The schedule contains participant pseudonyms but no gold labels or model outputs. Freeze the manifest, participant-dataset, and assignment-dataset digests before outcomes are inspected.

6. Collect blind units without `expectedStage`; annotators must not receive participant hashes, split, base or LearnLoop predictions, confidence, or admission decisions.
7. Finalize two independent labels per unit, with third-person adjudication for every disagreement:

```bash
lhic study learnloop finalize-labels \
  --plan benchmarks/learnloop-study/plan.json \
  --units results/learnloop-study-units.jsonl \
  --annotations results/learnloop-study-annotations.jsonl \
  --adjudications results/learnloop-study-adjudications.jsonl \
  --records-output results/learnloop-study-records.jsonl \
  --report-output results/learnloop-study-labeling-report.json
```

8. If a participant withdraws at any time, create redacted replacement source files before finalization or analysis:

```bash
lhic study learnloop withdraw \
  --units results/learnloop-study-units.jsonl \
  --annotations results/learnloop-study-annotations.jsonl \
  --adjudications results/learnloop-study-adjudications.jsonl \
  --participant-hash <secret-salted-participant-sha256> \
  --units-output results/redacted-units.jsonl \
  --annotations-output results/redacted-annotations.jsonl \
  --adjudications-output results/redacted-adjudications.jsonl \
  --receipt-output results/withdrawal-receipt.json
```

The command never overwrites input files. Securely replace or destroy the original source files and all prior finalized records, labeling reports, and analysis reports; then rerun finalization and analysis from the redacted outputs.

9. Analyze without overwriting an earlier report:

```bash
lhic study learnloop analyze \
  --plan benchmarks/learnloop-study/plan.json \
  --records results/learnloop-study-records.jsonl \
  --output results/learnloop-study-report.json
```

The analyzer rejects raw extra fields, invalid consent state, withdrawn records, pre-freeze records, collector-version drift, duplicate units, plan substitution, and any participant/session/task/UI-variant overlap between training and evaluation.

Execution materials are in `docs/xtf-study-operations-sop.md`, the two consent templates, the two participant-instruction templates, and `docs/xtf-study-annotation-rubric.md`. See `docs/xtf-study-preregistration.md` for the full protocol and claim limits.
