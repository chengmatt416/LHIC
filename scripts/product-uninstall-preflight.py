from pathlib import Path

for path in [
    Path("apps/cli/src/uninstaller.ts"),
    Path("apps/cli/src/uninstaller.test.ts"),
    Path("apps/cli/src/main.ts"),
    Path("apps/cli/src/interactive.ts"),
    Path("README.md"),
    Path("docs/uninstall.md"),
]:
    if not path.is_file():
        raise RuntimeError(f"Missing uninstall product file: {path}")
