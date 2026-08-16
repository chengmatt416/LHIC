#!/usr/bin/env python3
import json, shutil, subprocess, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EFFECT = ROOT / "effect.py"

def run(state: Path, aid: str, idem: str):
    return subprocess.run([
        "python3", str(EFFECT), "--state", str(state), "--logical-action-id", aid,
        "--mode", "post_commit_error", "--downstream-idempotency", idem,
    ], text=True, capture_output=True)

def main() -> int:
    d = Path(tempfile.mkdtemp(prefix="lhic-fair-selftest-"))
    try:
        state = d / "off.json"
        a, b = run(state, "A", "off"), run(state, "A", "off")
        s = json.loads(state.read_text())
        assert a.returncode == b.returncode == 17
        assert (s["attempts"], s["committedCount"]) == (2, 2), s
        state2 = d / "on.json"
        a, b = run(state2, "A", "on"), run(state2, "A", "on")
        s2 = json.loads(state2.read_text())
        assert (s2["attempts"], s2["committedCount"]) == (2, 1), s2
        state3 = d / "new.json"
        run(state3, "A", "on"); run(state3, "B", "on")
        s3 = json.loads(state3.read_text())
        assert (s3["attempts"], s3["committedCount"]) == (2, 2), s3
        print("fair fixture self-test: PASS")
        return 0
    finally:
        shutil.rmtree(d, ignore_errors=True)

if __name__ == "__main__":
    raise SystemExit(main())
