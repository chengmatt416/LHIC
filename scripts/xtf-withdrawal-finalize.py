from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


withdrawal = "apps/cli/src/learnloop-study-withdrawal.ts"
replace_once(
    withdrawal,
    '''  participantHash: string;
  withdrawnAt: string;''',
    '''  withdrawalSubjectCommitment: string;
  withdrawnAt: string;''',
)
replace_once(
    withdrawal,
    '''    participantHash,
    withdrawnAt,''',
    '''    withdrawalSubjectCommitment: hashState({
      planSha256,
      participantHash,
      withdrawnAt,
    }),
    withdrawnAt,''',
)
replace_once(
    withdrawal,
    '''      "A high kappa can coexist with a shared systematic labeling error; the gold-label rubric and audit sample must still be independently reviewed.",''',
    '''      "A high kappa can coexist with a shared systematic labeling error; the gold-label rubric and audit sample must still be independently reviewed.",''',
) if False else None

withdrawal_test = "apps/cli/src/learnloop-study-withdrawal.test.ts"
replace_once(
    withdrawal_test,
    '''    split: index === 0 ? "training" : "evaluation",''',
    '''    split: index === 2 ? "training" : "evaluation",''',
)
replace_once(
    withdrawal_test,
    '''    expect(
      redacted.receipt.invalidation.priorFinalizedRecordsMustBeDeleted,
    ).toBe(true);''',
    '''    expect(redacted.receipt.withdrawalSubjectCommitment).toMatch(
      /^[a-f0-9]{64}$/u,
    );
    expect(
      redacted.receipt.invalidation.priorFinalizedRecordsMustBeDeleted,
    ).toBe(true);''',
)

entry = "apps/cli/src/entry.ts"
replace_once(
    entry,
    '''} from "./learnloop-study-labeling.js";
import { parseMcpHarness }''',
    '''} from "./learnloop-study-labeling.js";
import {
  redactLearnLoopStudyParticipant,
  writeRedactedLearnLoopStudyData,
} from "./learnloop-study-withdrawal.js";
import { parseMcpHarness }''',
)
replace_once(
    entry,
    '''  lhic study learnloop digest --plan <plan.json>\n  lhic study learnloop finalize-labels''',
    '''  lhic study learnloop digest --plan <plan.json>\n  lhic study learnloop withdraw --units <units.jsonl> --annotations <annotations.jsonl> --adjudications <adjudications.jsonl> --participant-hash <sha256> --units-output <units.jsonl> --annotations-output <annotations.jsonl> --adjudications-output <adjudications.jsonl> --receipt-output <receipt.json>\n  lhic study learnloop finalize-labels''',
)
replace_once(
    entry,
    '''      if (action === "finalize-labels") {''',
    '''      if (action === "withdraw") {
        const options = parseStudyWithdrawalOptions(argumentsList.slice(3));
        const [units, annotations, adjudications] = await Promise.all([
          readLearnLoopStudyBlindUnits(options.unitsFile),
          readLearnLoopStudyAnnotations(options.annotationsFile),
          readLearnLoopStudyAdjudications(options.adjudicationsFile),
        ]);
        const redacted = redactLearnLoopStudyParticipant(
          units,
          annotations,
          adjudications,
          options.participantHash,
          new Date().toISOString(),
        );
        await writeRedactedLearnLoopStudyData(
          options.unitsOutputFile,
          options.annotationsOutputFile,
          options.adjudicationsOutputFile,
          options.receiptOutputFile,
          redacted,
        );
        console.log(JSON.stringify(redacted.receipt, null, 2));
        return;
      }
      if (action === "finalize-labels") {''',
)
replace_once(
    entry,
    '''        "LearnLoop study action must be digest, finalize-labels, or analyze. Run `lhic help` for usage.",''',
    '''        "LearnLoop study action must be digest, withdraw, finalize-labels, or analyze. Run `lhic help` for usage.",''',
)
replace_once(
    entry,
    '''function parseStudyLabelingOptions(argumentsList: string[]): {''',
    '''function parseStudyWithdrawalOptions(argumentsList: string[]): {
  unitsFile: string;
  annotationsFile: string;
  adjudicationsFile: string;
  participantHash: string;
  unitsOutputFile: string;
  annotationsOutputFile: string;
  adjudicationsOutputFile: string;
  receiptOutputFile: string;
} {
  const options = parseExactFlags(argumentsList, [
    "--units",
    "--annotations",
    "--adjudications",
    "--participant-hash",
    "--units-output",
    "--annotations-output",
    "--adjudications-output",
    "--receipt-output",
  ]);
  return {
    unitsFile: options["--units"]!,
    annotationsFile: options["--annotations"]!,
    adjudicationsFile: options["--adjudications"]!,
    participantHash: options["--participant-hash"]!,
    unitsOutputFile: options["--units-output"]!,
    annotationsOutputFile: options["--annotations-output"]!,
    adjudicationsOutputFile: options["--adjudications-output"]!,
    receiptOutputFile: options["--receipt-output"]!,
  };
}

function parseStudyLabelingOptions(argumentsList: string[]): {''',
)

readme = "benchmarks/learnloop-study/README.md"
replace_once(
    readme,
    '''7. Analyze without overwriting an earlier report:''',
    '''7. If a participant withdraws at any time, create redacted replacement source files before finalization or analysis:

```bash
lhic study learnloop withdraw \\
  --units results/learnloop-study-units.jsonl \\
  --annotations results/learnloop-study-annotations.jsonl \\
  --adjudications results/learnloop-study-adjudications.jsonl \\
  --participant-hash <secret-salted-participant-sha256> \\
  --units-output results/redacted-units.jsonl \\
  --annotations-output results/redacted-annotations.jsonl \\
  --adjudications-output results/redacted-adjudications.jsonl \\
  --receipt-output results/withdrawal-receipt.json
```

The command never overwrites input files. Securely replace or destroy the original source files and all prior finalized records, labeling reports, and analysis reports; then rerun finalization and analysis from the redacted outputs.

8. Analyze without overwriting an earlier report:''',
)

protocol = "docs/xtf-study-preregistration.md"
replace_once(
    protocol,
    '''A withdrawn participant's records must be deleted before analysis. The analyzer rejects records marked withdrawn rather than counting them as ordinary exclusions.''',
    '''A withdrawn participant's records must be deleted before analysis. The analyzer rejects records marked withdrawn rather than counting them as ordinary exclusions.

Use the implemented redaction command against the blind-unit and labeling source files:

```bash
lhic study learnloop withdraw \\
  --units results/learnloop-study-units.jsonl \\
  --annotations results/learnloop-study-annotations.jsonl \\
  --adjudications results/learnloop-study-adjudications.jsonl \\
  --participant-hash <secret-salted-participant-sha256> \\
  --units-output results/redacted-units.jsonl \\
  --annotations-output results/redacted-annotations.jsonl \\
  --adjudications-output results/redacted-adjudications.jsonl \\
  --receipt-output results/withdrawal-receipt.json
```

The command removes every blind unit for the participant and every annotation or adjudication bound to those unit hashes. It writes all four outputs with exclusive creation and rolls back newly created outputs if any write fails. The receipt includes before/after counts and order-independent digests, removed unit hashes, a non-linkable withdrawal-subject commitment, and explicit invalidation flags.

The command intentionally does not overwrite or securely erase source files. After verifying the receipt, the study operator must securely replace or destroy the original units, annotations, adjudications, any finalized records, labeling reports, and analysis reports. Finalization and analysis must then be rerun. The receipt is an audit aid, not a trusted timestamp or external signature; publish or countersign it through the preregistered study authority when independent proof is required.''',
)

xtf = "XTF-LEARNLOOP.md"
replace_once(
    xtf,
    '''The study kit first finalizes gold labels from blind units using two distinct annotators and mandatory independent adjudication for every disagreement. It reports raw agreement, Fleiss' kappa, label distributions, workloads, and order-independent dataset digests.''',
    '''The study kit first finalizes gold labels from blind units using two distinct annotators and mandatory independent adjudication for every disagreement. It reports raw agreement, Fleiss' kappa, label distributions, workloads, and order-independent dataset digests.

A participant-withdrawal command removes all matching blind units plus linked annotations and adjudications into four non-overwritable redacted outputs. Its receipt records before/after digests and invalidates every previously derived record or report, which must be deleted and regenerated.''',
)
replace_once(
    xtf,
    '''- `apps/cli/src/learnloop-study.test.ts`''',
    '''- `apps/cli/src/learnloop-study.test.ts`
- `apps/cli/src/learnloop-study-labeling.ts`
- `apps/cli/src/learnloop-study-labeling.test.ts`
- `apps/cli/src/learnloop-study-withdrawal.ts`
- `apps/cli/src/learnloop-study-withdrawal.test.ts`''',
)

review = "docs/xtf-adversarial-review.md"
replace_once(
    review,
    '''| High     | Gold labels copied from LearnLoop            | Treating the correction itself as the expected label makes accuracy circular.                                                               | The protocol requires blinded independent annotators, preregistered adjudication, and a frozen expected-stage label before paired analysis.                                                                                                              |''',
    '''| High     | Gold labels copied from LearnLoop            | Treating the correction itself as the expected label makes accuracy circular.                                                               | Blind units omit the expected stage. The finalizer requires two distinct blinded annotators, mandatory independent adjudication for every disagreement, and reports Fleiss' kappa plus immutable labeling digests.                                      |
| High     | Withdrawal deletes only the final record         | Removing an analyzed row while retaining its blind unit, annotations, adjudication, or derived reports violates the promised deletion boundary. | The withdrawal command removes every participant unit and linked labeling row, emits before/after digests and invalidation flags, rolls back partial outputs, and requires deletion and regeneration of all derived records and reports.                  |''',
)
replace_once(
    review,
    '''- preregistration parser, leakage controls, statistical analysis, and public CLI digest tests;''',
    '''- preregistration parser, blinded labeling, participant-withdrawal redaction, leakage controls, statistical analysis, and public CLI tests;''',
)
