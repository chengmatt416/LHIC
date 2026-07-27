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

5. Bind every JSONL record to that digest.
6. Analyze without overwriting an earlier report:

```bash
lhic study learnloop analyze \
  --plan benchmarks/learnloop-study/plan.json \
  --records results/learnloop-study-records.jsonl \
  --output results/learnloop-study-report.json
```

The analyzer rejects raw extra fields, invalid consent state, withdrawn records, pre-freeze records, collector-version drift, duplicate units, plan substitution, and any participant/session/task/UI-variant overlap between training and evaluation.

See `docs/xtf-study-preregistration.md` for the full protocol and claim limits.
