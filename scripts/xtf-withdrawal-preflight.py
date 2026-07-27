from pathlib import Path

path = Path("scripts/xtf-withdrawal-finalize.py")
text = path.read_text()
old = '''replace_once(
    entry,
    \'\'\'  lhic study learnloop digest --plan <plan.json>\\n  lhic study learnloop finalize-labels\'\'\',
    \'\'\'  lhic study learnloop digest --plan <plan.json>\\n  lhic study learnloop withdraw --units <units.jsonl> --annotations <annotations.jsonl> --adjudications <adjudications.jsonl> --participant-hash <sha256> --units-output <units.jsonl> --annotations-output <annotations.jsonl> --adjudications-output <adjudications.jsonl> --receipt-output <receipt.json>\\n  lhic study learnloop finalize-labels\'\'\',
)
'''
new = '''replace_once(
    entry,
    "  lhic study learnloop finalize-labels",
    "  lhic study learnloop withdraw --units <units.jsonl> --annotations <annotations.jsonl> --adjudications <adjudications.jsonl> --participant-hash <sha256> --units-output <units.jsonl> --annotations-output <annotations.jsonl> --adjudications-output <adjudications.jsonl> --receipt-output <receipt.json>\\\\n  lhic study learnloop finalize-labels",
)
'''
if text.count(old) != 1:
    raise RuntimeError("Unable to locate the withdrawal CLI usage replacement block.")
path.write_text(text.replace(old, new, 1))
