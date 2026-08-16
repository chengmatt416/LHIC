#!/usr/bin/env python3
import argparse
import json
import os
import sys
import time
from pathlib import Path


def commit_state(path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    current = {"count": 0, "events": []}
    if path.exists():
        current = json.loads(path.read_text(encoding="utf-8"))
    current["count"] = int(current.get("count", 0)) + 1
    current.setdefault("events", []).append(
        {"count": current["count"], "pid": os.getpid(), "timeNs": time.time_ns()}
    )
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    dir_fd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    return current["count"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--mode", choices=["success", "post_commit_error"], required=True)
    args = ap.parse_args()
    count = commit_state(Path(args.state))
    if args.mode == "post_commit_error":
        sys.stderr.write(f"SIMULATED_POST_COMMIT_ERROR count={count}\n")
        sys.stderr.flush()
        return 17
    print(f"COMMITTED count={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
