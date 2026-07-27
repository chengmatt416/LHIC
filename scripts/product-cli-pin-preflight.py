from pathlib import Path

for path in [
    Path("apps/cli/src/installer.ts"),
    Path("apps/cli/src/installer.test.ts"),
    Path("README.md"),
]:
    if not path.is_file():
        raise RuntimeError(f"Missing product file: {path}")

finalizer = Path("scripts/product-cli-pin-finalize.py")
text = finalizer.read_text()
needle = "'''      path:"
if text.count(needle) != 2:
    raise RuntimeError("Unable to locate both Windows path replacement literals.")
finalizer.write_text(text.replace(needle, "r'''      path:", 2))
