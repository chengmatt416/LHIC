from pathlib import Path

path = Path("apps/cli/src/learnloop-study-schedule.test.ts")
if not path.is_file():
    raise RuntimeError("Scheduler test fixture is missing.")
