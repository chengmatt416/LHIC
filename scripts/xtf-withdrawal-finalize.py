from pathlib import Path
import subprocess


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))


entry = "apps/cli/src/entry.ts"
replace_once(
    entry,
    '''} from "./learnloop-study-labeling.js";
import {
  redactLearnLoopStudyParticipant,''',
    '''} from "./learnloop-study-labeling.js";
import {
  buildLearnLoopStudySchedule,
  readLearnLoopStudyParticipants,
  readLearnLoopStudyTaskManifest,
  writeLearnLoopStudySchedule,
} from "./learnloop-study-schedule.js";
import {
  redactLearnLoopStudyParticipant,''',
)
replace_once(
    entry,
    '''  lhic study learnloop digest --plan <plan.json>
  lhic study learnloop withdraw''',
    '''  lhic study learnloop digest --plan <plan.json>
  lhic study learnloop schedule --plan <plan.json> --manifest <manifest.json> --participants <participants.jsonl> --output <schedule.json>
  lhic study learnloop withdraw''',
)
replace_once(
    entry,
    '''      if (action === "withdraw") {''',
    '''      if (action === "schedule") {
        const options = parseStudyScheduleOptions(argumentsList.slice(3));
        const plan = await readLearnLoopStudyPlan(options.planFile);
        const [manifest, participants] = await Promise.all([
          readLearnLoopStudyTaskManifest(plan, options.manifestFile),
          readLearnLoopStudyParticipants(plan, options.participantsFile),
        ]);
        const schedule = buildLearnLoopStudySchedule(
          plan,
          manifest,
          participants,
        );
        await writeLearnLoopStudySchedule(options.outputFile, schedule);
        console.log(JSON.stringify(schedule, null, 2));
        return;
      }
      if (action === "withdraw") {''',
)
replace_once(
    entry,
    '''LearnLoop study action must be digest, withdraw, finalize-labels, or analyze.''',
    '''LearnLoop study action must be digest, schedule, withdraw, finalize-labels, or analyze.''',
)
replace_once(
    entry,
    '''function parseStudyWithdrawalOptions(argumentsList: string[]): {''',
    '''function parseStudyScheduleOptions(argumentsList: string[]): {
  planFile: string;
  manifestFile: string;
  participantsFile: string;
  outputFile: string;
} {
  const options = parseExactFlags(argumentsList, [
    "--plan",
    "--manifest",
    "--participants",
    "--output",
  ]);
  return {
    planFile: options["--plan"]!,
    manifestFile: options["--manifest"]!,
    participantsFile: options["--participants"]!,
    outputFile: options["--output"]!,
  };
}

function parseStudyWithdrawalOptions(argumentsList: string[]): {''',
)

readme = "benchmarks/learnloop-study/README.md"
replace_once(
    readme,
    '''5. Collect blind units without `expectedStage`; annotators must not receive base or LearnLoop predictions.
6. Finalize two independent labels per unit, with third-person adjudication for every disagreement:''',
    '''5. Copy `task-manifest.example.json` and `participants.example.jsonl`, replace every placeholder, freeze the restricted manifest and consented participant enrollment set, and generate the deterministic balanced schedule:

```bash
lhic study learnloop schedule \\
  --plan benchmarks/learnloop-study/plan.json \\
  --manifest benchmarks/learnloop-study/task-manifest.json \\
  --participants results/participants.jsonl \\
  --output results/schedule.json
```

The manifest contains gold stages and remains restricted to the coordinator. The schedule contains participant pseudonyms but no gold labels or model outputs. Freeze the manifest, participant-dataset, and assignment-dataset digests before outcomes are inspected.

6. Collect blind units without `expectedStage`; annotators must not receive participant hashes, split, base or LearnLoop predictions, confidence, or admission decisions.
7. Finalize two independent labels per unit, with third-person adjudication for every disagreement:''',
)
replace_once(readme, "7. If a participant withdraws", "8. If a participant withdraws")
replace_once(readme, "8. Analyze without overwriting", "9. Analyze without overwriting")
replace_once(
    readme,
    '''See `docs/xtf-study-preregistration.md` for the full protocol and claim limits.''',
    '''Execution materials are in `docs/xtf-study-operations-sop.md`, the two consent templates, the two participant-instruction templates, and `docs/xtf-study-annotation-rubric.md`. See `docs/xtf-study-preregistration.md` for the full protocol and claim limits.''',
)

protocol = "docs/xtf-study-preregistration.md"
replace_once(
    protocol,
    '''## 6. Participants and consent''',
    '''## 5A. Deterministic task allocation and schedule freeze

Before outcomes are collected, create a restricted coordinator task manifest bound to the plan digest. The manifest must declare `containsGoldLabels: true`, include only preregistered languages and stages, use globally unique training/evaluation task and UI-variant hashes, and freeze a SHA-256 randomization seed.

After valid consent, store one exact-schema participant enrollment row per participant. Participant hashes must be study-specific secret-salted pseudonyms; each participant belongs to exactly one split and one language stratum.

Run:

```bash
lhic study learnloop schedule \\
  --plan benchmarks/learnloop-study/plan.json \\
  --manifest benchmarks/learnloop-study/task-manifest.json \\
  --participants results/participants.jsonl \\
  --output results/schedule.json
```

The schedule generator deterministically orders tasks, assigns the least-used eligible UI variant with a hash-based tie break, limits variant count imbalance to one, and fails when total units, required-language minima, expected-stage diversity, or train/evaluation separation cannot be satisfied. The non-overwritable output binds the plan, manifest, participant dataset, randomization seed, and assignment dataset by digest.

The schedule contains participant pseudonyms and is restricted to the coordinator. It deliberately omits gold labels and model outputs. Operational blinding still requires role-based access, separate annotator packets, and controlled task presentation. Freeze or trusted-timestamp the manifest, enrollment set, schedule, rubric, and participant-material versions before outcomes are inspected.

The execution SOP, consent templates, participant instructions, and annotation rubric are versioned in `docs/xtf-study-operations-sop.md`, `docs/xtf-study-consent-template.*.md`, `docs/xtf-study-participant-instructions.*.md`, and `docs/xtf-study-annotation-rubric.md`.

## 6. Participants and consent''',
)

xtf = "XTF-LEARNLOOP.md"
replace_once(
    xtf,
    '''The study kit first finalizes gold labels from blind units using two distinct annotators and mandatory independent adjudication for every disagreement.''',
    '''Before collection, the study kit freezes a restricted task/UI manifest and consented participant enrollment set, then generates a deterministic participant-disjoint schedule. It uses a frozen SHA-256 seed, balances eligible UI variants to a maximum count difference of one, fails when preregistered sample/language/stage minima cannot be met, and emits no gold labels or model outputs in the schedule.

The study kit then finalizes gold labels from blind units using two distinct annotators and mandatory independent adjudication for every disagreement.''',
)
replace_once(
    xtf,
    '''- `apps/cli/src/learnloop-study-withdrawal.test.ts`
- `apps/desktop/src/main/prediction-first-browser-admission.ts`''',
    '''- `apps/cli/src/learnloop-study-withdrawal.test.ts`
- `apps/cli/src/learnloop-study-schedule.ts`
- `apps/cli/src/learnloop-study-schedule.test.ts`
- `apps/desktop/src/main/prediction-first-browser-admission.ts`''',
)
replace_once(
    xtf,
    '''- `benchmarks/learnloop-study/plan.example.json`
- `docs/xtf-study-preregistration.md`''',
    '''- `benchmarks/learnloop-study/plan.example.json`
- `benchmarks/learnloop-study/task-manifest.example.json`
- `benchmarks/learnloop-study/participants.example.jsonl`
- `docs/xtf-study-preregistration.md`
- `docs/xtf-study-operations-sop.md`
- `docs/xtf-study-annotation-rubric.md`
- `docs/xtf-study-consent-template.en.md`
- `docs/xtf-study-consent-template.zh-TW.md`
- `docs/xtf-study-participant-instructions.en.md`
- `docs/xtf-study-participant-instructions.zh-TW.md`''',
)

review = "docs/xtf-adversarial-review.md"
anchor = "| Medium   | Aggregate result hides language failure"
review_file = Path(review)
review_text = review_file.read_text()
new_row = "| High     | Post-hoc participant/task assignment          | Choosing participants, task order, or UI variants after inspecting outcomes can create an artificial improvement even with a frozen analyzer.           | Added a plan-bound restricted task manifest, exact-schema consented participant enrollment, fixed SHA-256 seed, deterministic ordering, globally disjoint task/UI hashes, balanced UI-variant allocation, sample/language/stage preflight, immutable schedule digests, and non-overwritable output. Operational access control and trusted timestamping remain required. |"
if new_row not in review_text:
    if review_text.count(anchor) != 1:
        raise RuntimeError("Unable to locate evidence-methodology table anchor.")
    review_file.write_text(review_text.replace(anchor, f"{new_row}\n{anchor}", 1))

subprocess.run(
    [
        "npx",
        "prettier",
        "--write",
        "apps/cli/src/learnloop-study-schedule.ts",
        "apps/cli/src/learnloop-study-schedule.test.ts",
        "apps/cli/src/entry.ts",
        "benchmarks/learnloop-study/README.md",
        "benchmarks/learnloop-study/task-manifest.example.json",
        "docs/xtf-study-preregistration.md",
        "docs/xtf-study-operations-sop.md",
        "docs/xtf-study-annotation-rubric.md",
        "docs/xtf-study-consent-template.en.md",
        "docs/xtf-study-consent-template.zh-TW.md",
        "docs/xtf-study-participant-instructions.en.md",
        "docs/xtf-study-participant-instructions.zh-TW.md",
        "docs/xtf-adversarial-review.md",
        "XTF-LEARNLOOP.md",
    ],
    check=True,
)
