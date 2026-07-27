from pathlib import Path

for path in [
    Path("apps/cli/src/installer.ts"),
    Path("apps/cli/src/installer.test.ts"),
    Path("README.md"),
]:
    if not path.is_file():
        raise RuntimeError(f"Missing product file: {path}")
