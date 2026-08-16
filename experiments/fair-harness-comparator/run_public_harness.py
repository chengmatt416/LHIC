#!/usr/bin/env python3
import argparse, hashlib, json, os, shutil, signal, socket, subprocess, sys, time
from pathlib import Path

def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]

def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()

def load_json(path: Path, fallback=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback

def binary_metadata(binary: str) -> dict:
    p = Path(binary).resolve()
    try:
        version = subprocess.run([binary, "--version"], text=True, capture_output=True, check=False, timeout=10)
        version_text = (version.stdout + version.stderr).strip()
    except Exception as e:
        version_text = f"VERSION_ERROR:{e}"
    return {
        "path": str(p),
        "sha256": sha256_file(p) if p.is_file() else None,
        "version": version_text,
    }

def reset_state_path(state_path: Path):
    prefix = Path("/tmp/lhic-fair-harness")
    try:
        state_path.resolve().relative_to(prefix.resolve())
    except Exception as e:
        raise RuntimeError(f"refusing to reset unexpected state path: {state_path}") from e
    shutil.rmtree(state_path.parent, ignore_errors=True)
    state_path.parent.mkdir(parents=True, exist_ok=True)

def run_trial(args, manifest: dict, entry: dict):
    plan_path = Path(args.fixtures) / entry["path"]
    plan_raw = plan_path.read_bytes()
    plan_sha = hashlib.sha256(plan_raw).hexdigest()
    if plan_sha != entry["sha256"]:
        raise RuntimeError(f"fixture hash mismatch: {entry['path']}")
    plan = json.loads(plan_raw)
    condition, trial = plan["condition"], int(plan["trial"])
    trial_dir = Path(args.out) / condition / f"trial-{trial:02d}"
    trial_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(plan_path, trial_dir / "plan.json")
    state_path = Path(plan["statePath"])
    reset_state_path(state_path)

    provider_log = trial_dir / "provider.jsonl"
    provider_stdout_path = trial_dir / "provider.stdout.log"
    harness_stdout = trial_dir / "harness.stdout.log"
    harness_stderr = trial_dir / "harness.stderr.log"
    port = free_port()
    provider_stdout = provider_stdout_path.open("w", encoding="utf-8")
    provider = subprocess.Popen([
        sys.executable, str(Path(args.provider).resolve()),
        "--port", str(port), "--log", str(provider_log.resolve()), "--plan", str(plan_path.resolve()),
    ], stdout=provider_stdout, stderr=subprocess.STDOUT, start_new_session=True, cwd=args.repo_root)
    time.sleep(0.35)

    env = os.environ.copy()
    prompt = "Execute exactly the model-requested tool action. Do not alter the command or invent another action."
    if args.harness == "codex":
        codex_home = Path("/tmp/lhic-fair-codex") / f"{condition}-{trial:02d}"
        shutil.rmtree(codex_home, ignore_errors=True)
        codex_home.mkdir(parents=True, exist_ok=True)
        (codex_home / "config.toml").write_text(
            f'''model = "gpt-5.2"\nmodel_provider = "lhic_fair_mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[model_providers.lhic_fair_mock]\nname = "LHIC fair deterministic comparator"\nbase_url = "http://127.0.0.1:{port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n''',
            encoding="utf-8",
        )
        env["CODEX_HOME"] = str(codex_home)
        cmd = [args.binary, "exec", "--skip-git-repo-check", "--ephemeral", "--json", prompt]
    elif args.harness == "goose":
        env.update({
            "GOOSE_PROVIDER": "openai",
            "GOOSE_MODEL": "gpt-5.2",
            "GOOSE_MODE": "auto",
            "GOOSE_MAX_TURNS": "8",
            "GOOSE_DISABLE_SESSION_NAMING": "true",
            "GOOSE_TELEMETRY_ENABLED": "false",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{port}/v1",
        })
        cmd = [args.binary, "run", "--no-session", "--no-profile", "--with-builtin", "developer", "-t", prompt]
    else:
        raise ValueError(args.harness)

    timed_out = False
    started = time.perf_counter()
    try:
        with harness_stdout.open("w", encoding="utf-8") as out_f, harness_stderr.open("w", encoding="utf-8") as err_f:
            cp = subprocess.run(cmd, env=env, cwd=args.repo_root, stdout=out_f, stderr=err_f,
                                timeout=args.timeout, check=False)
        rc = cp.returncode
    except subprocess.TimeoutExpired:
        timed_out, rc = True, 124
    elapsed_ms = (time.perf_counter() - started) * 1000

    try:
        os.killpg(provider.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        provider.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(provider.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    provider_stdout.close()

    events = []
    if provider_log.exists():
        for line in provider_log.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                events.append(json.loads(line))
            except Exception:
                pass
    issued = [e for e in events if e.get("event") == "issued_tool_call"]
    observed = [e for e in events if e.get("event") == "observed_tool_result"]
    invalid = [e for e in events if e.get("event") == "fixture_invalid"]
    complete = [e for e in events if e.get("event") == "fixture_complete"]
    state = load_json(state_path, {"attempts": 0, "committedCount": 0, "events": []}) or {}
    attempts = int(state.get("attempts", 0))
    committed = int(state.get("committedCount", 0))
    ids = [p["logicalActionId"] for p in plan["proposals"]]
    same_id = len(ids) == 2 and ids[0] == ids[1]
    committed_by_id = {}
    for e in state.get("events", []) or []:
        if e.get("committed"):
            aid = e.get("logicalActionId")
            committed_by_id[aid] = committed_by_id.get(aid, 0) + 1
    duplicate_commits = sum(max(0, n - 1) for n in committed_by_id.values())
    provider_valid = (
        not invalid and len(issued) == len(plan["proposals"]) and
        len(observed) == len(plan["proposals"]) and all(e.get("valid") for e in observed) and
        bool(complete) and complete[-1].get("valid") is True
    )
    result = {
        "harness": args.harness,
        "condition": condition,
        "trial": trial,
        "planSha256": plan_sha,
        "fixtureManifestSha256": manifest["manifestSha256"],
        "logicalActionIds": ids,
        "commandSha256s": [p["commandSha256"] for p in plan["proposals"]],
        "sameLogicalActionPlan": same_id,
        "harnessExitCode": rc,
        "timedOut": timed_out,
        "providerValid": provider_valid,
        "plannerProposalsIssued": len(issued),
        "physicalDispatchAttempts": attempts,
        "committedEffects": committed,
        "secondPhysicalDispatch": attempts >= 2,
        "sameLogicalActionSecondDispatch": same_id and attempts >= 2,
        "duplicateCommittedEffects": duplicate_commits,
        "downstreamSuppressedDispatches": max(0, attempts - committed),
        "elapsedMs": round(elapsed_ms, 3),
        "toolName": issued[0].get("tool") if issued else None,
        "valid": (not timed_out and rc == 0 and provider_valid and attempts >= 1),
    }
    (trial_dir / "result.json").write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if state_path.exists():
        shutil.copy2(state_path, trial_dir / "state.json")
    print(json.dumps(result, sort_keys=True), flush=True)
    return result

def summarize(results, condition):
    rs = [r for r in results if r["condition"] == condition]
    return {
        "trials": len(rs),
        "validTrials": sum(1 for r in rs if r["valid"]),
        "secondPhysicalDispatchTrials": sum(1 for r in rs if r["secondPhysicalDispatch"]),
        "sameLogicalActionSecondDispatchTrials": sum(1 for r in rs if r["sameLogicalActionSecondDispatch"]),
        "duplicateCommittedEffects": sum(r["duplicateCommittedEffects"] for r in rs),
        "downstreamSuppressedDispatches": sum(r["downstreamSuppressedDispatches"] for r in rs),
        "meanPhysicalDispatchAttempts": sum(r["physicalDispatchAttempts"] for r in rs) / len(rs),
        "meanCommittedEffects": sum(r["committedEffects"] for r in rs) / len(rs),
        "toolNames": sorted({r["toolName"] for r in rs if r["toolName"]}),
    }

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--harness", choices=["codex", "goose"], required=True)
    ap.add_argument("--binary", required=True)
    ap.add_argument("--fixtures", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo-root", default=os.getcwd())
    ap.add_argument("--provider", default="experiments/fair-harness-comparator/provider.py")
    ap.add_argument("--timeout", type=int, default=30)
    args = ap.parse_args()
    manifest = json.loads((Path(args.fixtures) / "manifest.json").read_text(encoding="utf-8"))
    results = [run_trial(args, manifest, entry) for entry in manifest["entries"]]
    conditions = {c: summarize(results, c) for c in manifest["conditions"]}
    summary = {
        "schemaVersion": "lhic-fair-public-harness-summary-v1",
        "harness": args.harness,
        "binary": binary_metadata(args.binary),
        "fixtureManifestSha256": manifest["manifestSha256"],
        "conditions": conditions,
        "results": results,
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    invalid_trials = [r for r in results if not r["valid"]]
    return 2 if invalid_trials else 0

if __name__ == "__main__":
    raise SystemExit(main())
