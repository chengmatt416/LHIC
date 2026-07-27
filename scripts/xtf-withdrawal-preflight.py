from pathlib import Path

required = [
    Path("apps/cli/src/learnloop-study-schedule.ts"),
    Path("apps/cli/src/learnloop-study-schedule.test.ts"),
    Path("docs/xtf-study-operations-sop.md"),
]
missing = [str(path) for path in required if not path.is_file()]
if missing:
    raise RuntimeError(f"Missing execution-kit files: {missing}")
