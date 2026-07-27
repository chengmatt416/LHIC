from pathlib import Path

required = [
    Path("apps/cli/src/installer.ts"),
    Path("apps/cli/src/installer.test.ts"),
    Path(".github/workflows/product-readiness.yml"),
]
missing = [str(path) for path in required if not path.is_file()]
if missing:
    raise RuntimeError(f"Missing desktop installer files: {missing}")
