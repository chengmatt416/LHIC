from pathlib import Path
import json

path = Path("package-lock.json")
lock = json.loads(path.read_text())
packages = lock.get("packages", {})
for key in list(packages):
    if key == "node_modules/sharp" or key.startswith("node_modules/@img/sharp-"):
        del packages[key]
path.write_text(json.dumps(lock, indent=2) + "\n")
