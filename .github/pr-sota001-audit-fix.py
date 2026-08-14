from pathlib import Path
import json

path = Path("package.json")
package = json.loads(path.read_text())
overrides = package.setdefault("overrides", {})
overrides.pop("@huggingface/transformers", None)
overrides["sharp"] = "0.35.3"
path.write_text(json.dumps(package, indent=2) + "\n")
