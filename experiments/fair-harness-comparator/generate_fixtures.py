#!/usr/bin/env python3
import argparse, hashlib, json, shlex
from pathlib import Path

SCHEMA = "lhic-fair-harness-fixture-v1"
CONDITIONS = (
    "no_fault",
    "post_commit_error_same_id",
    "post_commit_error_new_id",
    "post_commit_error_same_id_downstream_idempotent",
)

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def command_for(state_path: str, action_id: str, mode: str, downstream: str) -> str:
    parts = [
        "python3",
        "experiments/fair-harness-comparator/effect.py",
        "--state", state_path,
        "--logical-action-id", action_id,
        "--mode", mode,
        "--downstream-idempotency", downstream,
    ]
    return " ".join(shlex.quote(x) for x in parts)

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=10)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    root = Path(args.out)
    root.mkdir(parents=True, exist_ok=True)
    entries = []
    for condition in CONDITIONS:
        for trial in range(1, args.trials + 1):
            state_path = f"/tmp/lhic-fair-harness/{condition}/trial-{trial:02d}/state.json"
            base_id = f"fair:{condition}:{trial:02d}:A"
            mode = "success" if condition == "no_fault" else "post_commit_error"
            downstream = "on" if condition.endswith("downstream_idempotent") else "off"
            first_cmd = command_for(state_path, base_id, mode, downstream)
            proposals = [{
                "ordinal": 1,
                "logicalActionId": base_id,
                "command": first_cmd,
                "commandSha256": sha256_bytes(first_cmd.encode()),
            }]
            if condition != "no_fault":
                retry_id = (
                    f"fair:{condition}:{trial:02d}:B"
                    if condition == "post_commit_error_new_id"
                    else base_id
                )
                retry_cmd = command_for(state_path, retry_id, mode, downstream)
                proposals.append({
                    "ordinal": 2,
                    "logicalActionId": retry_id,
                    "command": retry_cmd,
                    "commandSha256": sha256_bytes(retry_cmd.encode()),
                })
            plan = {
                "schemaVersion": SCHEMA,
                "condition": condition,
                "trial": trial,
                "statePath": state_path,
                "effectMode": mode,
                "downstreamIdempotency": downstream,
                "plannerPolicy": {
                    "initial": "issue proposal 1",
                    "retry": "issue proposal 2 only after validated exit code 17" if len(proposals) == 2 else "none",
                    "maxProposals": len(proposals),
                },
                "proposals": proposals,
            }
            raw = (json.dumps(plan, indent=2, sort_keys=True) + "\n").encode()
            rel = Path(condition) / f"trial-{trial:02d}.json"
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            entries.append({
                "path": rel.as_posix(),
                "sha256": sha256_bytes(raw),
                "condition": condition,
                "trial": trial,
            })
    manifest_core = {
        "schemaVersion": "lhic-fair-harness-manifest-v1",
        "trialsPerCondition": args.trials,
        "conditions": list(CONDITIONS),
        "entries": entries,
    }
    canonical = json.dumps(manifest_core, sort_keys=True, separators=(",", ":")).encode()
    manifest = dict(manifest_core)
    manifest["manifestSha256"] = sha256_bytes(canonical)
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(manifest["manifestSha256"])
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
