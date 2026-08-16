#!/usr/bin/env python3
import argparse, json, os, sys, time
from pathlib import Path

SCHEMA = "lhic-fair-effect-state-v1"

def durable_write(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    dfd = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)

def load_state(path: Path) -> dict:
    if not path.exists():
        return {"schemaVersion": SCHEMA, "attempts": 0, "committedCount": 0, "seenActionIds": [], "events": []}
    return json.loads(path.read_text(encoding="utf-8"))

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--state", required=True)
    ap.add_argument("--logical-action-id", required=True)
    ap.add_argument("--mode", choices=["success", "post_commit_error"], required=True)
    ap.add_argument("--downstream-idempotency", choices=["off", "on"], required=True)
    args = ap.parse_args()
    path = Path(args.state)
    state = load_state(path)
    state["attempts"] = int(state.get("attempts", 0)) + 1
    seen = list(state.get("seenActionIds", []))
    suppress = args.downstream_idempotency == "on" and args.logical_action_id in seen
    committed = not suppress
    if committed:
        state["committedCount"] = int(state.get("committedCount", 0)) + 1
        if args.logical_action_id not in seen:
            seen.append(args.logical_action_id)
    state["seenActionIds"] = seen
    event = {
        "attempt": state["attempts"],
        "logicalActionId": args.logical_action_id,
        "committed": committed,
        "committedCount": state["committedCount"],
        "mode": args.mode,
        "downstreamIdempotency": args.downstream_idempotency,
        "pid": os.getpid(),
        "timeNs": time.time_ns(),
    }
    state.setdefault("events", []).append(event)
    durable_write(path, state)
    marker = "FAIR_EFFECT_RESULT " + json.dumps(event, sort_keys=True, separators=(",", ":"))
    if args.mode == "post_commit_error":
        print(marker, file=sys.stderr, flush=True)
        return 17
    print(marker, flush=True)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
