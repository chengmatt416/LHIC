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

script = Path("scripts/xtf-withdrawal-finalize.py")
text = script.read_text()
old_anchor = '''    ''' + "'''  lhic study learnloop digest --plan <plan.json>\n  lhic study learnloop withdraw'''" + ''','''
new_anchor = '''    r''' + "'''  lhic study learnloop digest --plan <plan.json>\\n  lhic study learnloop withdraw'''" + ''','''
old_replacement = '''    ''' + "'''  lhic study learnloop digest --plan <plan.json>\n  lhic study learnloop schedule --plan <plan.json> --manifest <manifest.json> --participants <participants.jsonl> --output <schedule.json>\n  lhic study learnloop withdraw'''" + ''','''
new_replacement = '''    r''' + "'''  lhic study learnloop digest --plan <plan.json>\\n  lhic study learnloop schedule --plan <plan.json> --manifest <manifest.json> --participants <participants.jsonl> --output <schedule.json>\\n  lhic study learnloop withdraw'''" + ''','''
if old_anchor not in text or old_replacement not in text:
    raise RuntimeError("Unable to locate literal CLI usage replacements.")
script.write_text(
    text.replace(old_anchor, new_anchor, 1).replace(
        old_replacement,
        new_replacement,
        1,
    )
)
