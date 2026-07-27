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

script = Path("scripts/xtf-withdrawal-finalize.py")
text = script.read_text()
old_anchor = '''    ''' + "'''XTF research commands:\\n  lhic bench learnloop'''" + ''','''
new_anchor = '''    r''' + "'''XTF research commands:\\n  lhic bench learnloop'''" + ''','''
old_replacement = '''    ''' + "'''Product data commands:\\n  lhic data inventory [--root <directory>] [--output <inventory.json>]\\n  lhic data erase --root <directory> --confirm <token> --receipt <receipt.json>\\n\\nXTF research commands:\\n  lhic bench learnloop'''" + ''','''
new_replacement = '''    r''' + "'''Product data commands:\\n  lhic data inventory [--root <directory>] [--output <inventory.json>]\\n  lhic data erase --root <directory> --confirm <token> --receipt <receipt.json>\\n\\nXTF research commands:\\n  lhic bench learnloop'''" + ''','''
if old_anchor not in text or old_replacement not in text:
    raise RuntimeError("Unable to locate product CLI help literal replacements.")
script.write_text(
    text.replace(old_anchor, new_anchor, 1).replace(
        old_replacement,
        new_replacement,
        1,
    )
)
