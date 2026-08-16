#!/usr/bin/env python3
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def read_count(path: Path):
    if not path.exists():
        return 0
    try:
        return int(json.loads(path.read_text(encoding="utf-8")).get("count", 0))
    except Exception:
        return -1


def run_trial(args, condition, trial_index):
    trial_dir = Path(args.out) / condition / f"trial-{trial_index:02d}"
    trial_dir.mkdir(parents=True, exist_ok=True)
    state_path = trial_dir / "state.json"
    provider_log = trial_dir / "provider.jsonl"
    provider_stdout = (trial_dir / "provider.stdout.log").open("w", encoding="utf-8")
    harness_stdout = trial_dir / "harness.stdout.log"
    harness_stderr = trial_dir / "harness.stderr.log"
    port = free_port()
    retry = condition == "post_commit_error"
    effect_mode = "post_commit_error" if retry else "success"

    provider_cmd = [
        sys.executable,
        str(Path(args.provider).resolve()),
        "--port", str(port),
        "--log", str(provider_log.resolve()),
        "--state", str(state_path.resolve()),
        "--effect-script", str(Path(args.effect_script).resolve()),
        "--effect-mode", effect_mode,
    ]
    if retry:
        provider_cmd.append("--retry-after-first-result")
    provider = subprocess.Popen(
        provider_cmd,
        stdout=provider_stdout,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    time.sleep(0.4)

    env = os.environ.copy()
    prompt = "Execute the model-requested tool action. Do not invent a different command."
    if args.harness == "codex":
        env["CODEX_HOME"] = str(Path(args.codex_home).resolve())
        cmd = [
            args.binary,
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--json",
            prompt,
        ]
    elif args.harness == "goose":
        env.update(
            {
                "GOOSE_PROVIDER": "openai",
                "GOOSE_MODEL": "gpt-5.2",
                "GOOSE_MODE": "auto",
                "GOOSE_MAX_TURNS": "6",
                "GOOSE_DISABLE_SESSION_NAMING": "true",
                "GOOSE_TELEMETRY_ENABLED": "false",
                "OPENAI_BASE_URL": f"http://127.0.0.1:{port}/v1",
            }
        )
        cmd = [
            args.binary,
            "run",
            "--no-session",
            "--no-profile",
            "--with-builtin",
            "developer",
            "-t",
            prompt,
        ]
    else:
        raise ValueError(args.harness)

    if args.harness == "codex":
        # Codex provider URL is trial-specific, so write a fresh isolated config.
        home = Path(args.codex_home)
        home.mkdir(parents=True, exist_ok=True)
        (home / "config.toml").write_text(
            f'''model = "gpt-5.2"\nmodel_provider = "lhic_mock"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n[model_providers.lhic_mock]\nname = "LHIC deterministic comparator"\nbase_url = "http://127.0.0.1:{port}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nrequires_openai_auth = false\n''',
            encoding="utf-8",
        )

    timed_out = False
    started = time.perf_counter()
    try:
        with harness_stdout.open("w", encoding="utf-8") as out_f, harness_stderr.open("w", encoding="utf-8") as err_f:
            completed = subprocess.run(
                cmd,
                env=env,
                cwd=os.getcwd(),
                stdout=out_f,
                stderr=err_f,
                timeout=args.timeout,
                check=False,
            )
        rc = completed.returncode
    except subprocess.TimeoutExpired:
        timed_out = True
        rc = 124
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
    requests = [e for e in events if e.get("event") == "request"]
    count = read_count(state_path)
    result = {
        "harness": args.harness,
        "condition": condition,
        "trial": trial_index,
        "exitCode": rc,
        "timedOut": timed_out,
        "providerRequests": len(requests),
        "plannerToolCallsIssued": len(issued),
        "physicalSideEffects": count,
        "duplicateSideEffects": max(0, count - 1),
        "secondPhysicalDispatch": count >= 2,
        "elapsedMs": round(elapsed_ms, 3),
        "toolName": issued[0].get("tool") if issued else None,
        "valid": count >= 1 and len(issued) >= 1 and not timed_out,
    }
    (trial_dir / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result), flush=True)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--harness", choices=["codex", "goose"], required=True)
    ap.add_argument("--binary", required=True)
    ap.add_argument("--trials", type=int, default=10)
    ap.add_argument("--out", required=True)
    ap.add_argument("--provider", default="experiments/public-harness-comparator/comparator_provider.py")
    ap.add_argument("--effect-script", default="experiments/public-harness-comparator/effect.py")
    ap.add_argument("--codex-home", default="/tmp/lhic-codex-comparator")
    ap.add_argument("--timeout", type=int, default=30)
    args = ap.parse_args()

    all_results = []
    for condition in ["no_fault", "post_commit_error"]:
        for i in range(1, args.trials + 1):
            all_results.append(run_trial(args, condition, i))

    def summarize(condition):
        rs = [r for r in all_results if r["condition"] == condition]
        return {
            "trials": len(rs),
            "validTrials": sum(1 for r in rs if r["valid"]),
            "secondDispatchTrials": sum(1 for r in rs if r["secondPhysicalDispatch"]),
            "duplicateSideEffects": sum(r["duplicateSideEffects"] for r in rs),
            "meanPhysicalSideEffects": sum(r["physicalSideEffects"] for r in rs) / len(rs),
            "toolNames": sorted({r["toolName"] for r in rs if r["toolName"]}),
        }

    summary = {
        "schemaVersion": "lhic-public-harness-comparator-v1",
        "harness": args.harness,
        "planner": "deterministic local Responses provider",
        "conditions": {
            "no_fault": summarize("no_fault"),
            "post_commit_error": summarize("post_commit_error"),
        },
        "results": all_results,
    }
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary["conditions"], indent=2))

    # Infrastructure validity gate only. Measured second-dispatch behavior is not an expected assertion.
    invalid = [r for r in all_results if not r["valid"]]
    if invalid:
        print(f"invalid trials: {len(invalid)}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
