from pathlib import Path

required = [
    Path("apps/cli/src/learnloop-study-schedule.ts"),
    Path("apps/cli/src/learnloop-study-schedule.test.ts"),
    Path("benchmarks/learnloop-study/task-manifest.example.json"),
    Path("benchmarks/learnloop-study/participants.example.jsonl"),
    Path("docs/xtf-study-operations-sop.md"),
    Path("docs/xtf-study-annotation-rubric.md"),
    Path("docs/xtf-study-consent-template.en.md"),
    Path("docs/xtf-study-consent-template.zh-TW.md"),
    Path("docs/xtf-study-participant-instructions.en.md"),
    Path("docs/xtf-study-participant-instructions.zh-TW.md"),
]
missing = [str(path) for path in required if not path.is_file()]
if missing:
    raise RuntimeError(f"Missing study execution-kit files: {missing}")
