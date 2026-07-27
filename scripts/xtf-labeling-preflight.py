from pathlib import Path

path = Path("XTF-LEARNLOOP.md")
text = path.read_text()
anchor = "Analyze consented JSONL records and write a non-overwritable report:"
marker = "The tooling enforces before analysis:"
if marker not in text:
    if text.count(anchor) != 1:
        raise RuntimeError("Unable to locate the XTF study-tooling anchor.")
    path.write_text(text.replace(anchor, f"{marker}\n\n{anchor}", 1))
