import subprocess

files = [
    "apps/cli/src/learnloop-study-schedule.ts",
    "apps/cli/src/learnloop-study-schedule.test.ts",
    "docs/xtf-study-operations-sop.md",
]
subprocess.run(["npx", "prettier", "--write", *files], check=True)
subprocess.run(["git", "add", *files], check=True)
