from pathlib import Path

required = [
    Path("apps/cli/src/product-data.ts"),
    Path("apps/cli/src/product-data.test.ts"),
    Path("docs/product-data-lifecycle.md"),
    Path(".github/workflows/product-readiness.yml"),
]
missing = [str(path) for path in required if not path.is_file()]
if missing:
    raise RuntimeError(f"Missing product data lifecycle files: {missing}")
