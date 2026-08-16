#!/usr/bin/env python3
import argparse, json
from pathlib import Path

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True, help="directory containing fixtures/ and results/")
    args = ap.parse_args()
    root = Path(args.root)
    manifest = json.loads((root / "fixtures" / "manifest.json").read_text())
    names = ["codex", "goose", "lhic"]
    summaries = {n: json.loads((root / "results" / n / "summary.json").read_text()) for n in names}
    manifest_sha = manifest["manifestSha256"]
    assert all(s["fixtureManifestSha256"] == manifest_sha for s in summaries.values())

    def keyset(summary):
        return {
            (r["condition"], int(r["trial"]), r["planSha256"], tuple(r["logicalActionIds"]), tuple(r["commandSha256s"]))
            for r in summary["results"]
        }
    base = keyset(summaries["codex"])
    assert keyset(summaries["goose"]) == base
    assert keyset(summaries["lhic"]) == base

    all_valid = all(r["valid"] for s in summaries.values() for r in s["results"])
    no_fault_control = all(
        r["physicalDispatchAttempts"] == 1 and r["committedEffects"] == 1
        for s in summaries.values() for r in s["results"] if r["condition"] == "no_fault"
    )
    downstream_control = all(
        r["duplicateCommittedEffects"] == 0
        for s in summaries.values() for r in s["results"]
        if r["condition"] == "post_commit_error_same_id_downstream_idempotent"
    )
    fixture_control_passed = all_valid and no_fault_control and downstream_control

    rows = []
    for name in names:
        s = summaries[name]
        rows.append({
            "harness": s["harness"],
            "binary": s.get("binary"),
            "runtime": s.get("runtime"),
            "conditions": s["conditions"],
        })
    combined = {
        "schemaVersion": "lhic-fair-harness-combined-v1",
        "fixtureManifestSha256": manifest_sha,
        "fixtureIdentityEqualAcrossHarnesses": True,
        "allTrialsInfrastructureValid": all_valid,
        "noFaultControlPassed": no_fault_control,
        "downstreamIdempotencyControlPassed": downstream_control,
        "fixtureControlGatePassed": fixture_control_passed,
        "rows": rows,
    }
    (root / "combined-summary.json").write_text(json.dumps(combined, indent=2, sort_keys=True) + "\n")

    def c(name, condition):
        return summaries[name]["conditions"][condition]
    lines = [
        "# Fair public-harness comparator results", "",
        f"Fixture manifest SHA-256: `{manifest_sha}`", "",
        f"Infrastructure-valid trials: **{'PASS' if all_valid else 'FAIL'}**", "",
        f"No-fault control: **{'PASS' if no_fault_control else 'FAIL'}**", "",
        f"Downstream-idempotency control: **{'PASS' if downstream_control else 'FAIL'}**", "",
        "## Same logical action ID after post-commit error", "",
        "| Harness | Valid | Second physical dispatch | Duplicate committed effects | Mean dispatch attempts |",
        "|---|---:|---:|---:|---:|",
    ]
    for n in names:
        x = c(n, "post_commit_error_same_id")
        lines.append(f"| {summaries[n]['harness']} | {x['validTrials']}/{x['trials']} | {x['sameLogicalActionSecondDispatchTrials']}/{x['trials']} | {x['duplicateCommittedEffects']} | {x['meanPhysicalDispatchAttempts']:.2f} |")
    lines += ["", "## Negative control: new logical action ID", "",
              "| Harness | Valid | Second physical dispatch | Duplicate committed effects | Mean dispatch attempts |",
              "|---|---:|---:|---:|---:|"]
    for n in names:
        x = c(n, "post_commit_error_new_id")
        lines.append(f"| {summaries[n]['harness']} | {x['validTrials']}/{x['trials']} | {x['secondPhysicalDispatchTrials']}/{x['trials']} | {x['duplicateCommittedEffects']} | {x['meanPhysicalDispatchAttempts']:.2f} |")
    lines += ["", "## Downstream idempotency control", "",
              "| Harness | Valid | Second physical dispatch | Duplicate committed effects | Suppressed downstream dispatches |",
              "|---|---:|---:|---:|---:|"]
    for n in names:
        x = c(n, "post_commit_error_same_id_downstream_idempotent")
        lines.append(f"| {summaries[n]['harness']} | {x['validTrials']}/{x['trials']} | {x['sameLogicalActionSecondDispatchTrials']}/{x['trials']} | {x['duplicateCommittedEffects']} | {x['downstreamSuppressedDispatches']} |")
    lines += ["", "This is a controlled execution-semantics experiment, not a planner-quality or public benchmark score.", ""]
    (root / "RESULTS.md").write_text("\n".join(lines))
    print(json.dumps(combined, indent=2))
    return 0 if fixture_control_passed else 3

if __name__ == "__main__":
    raise SystemExit(main())
