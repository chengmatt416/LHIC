"""Inject the LHIC agent into a pinned legacy tau-bench checkout."""

from __future__ import annotations

import importlib
import json
import runpy
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from lhic_tau_bench_agent import LhicTauBenchAgent


TAU_BENCH_REVISION = "59a200c6d575d595120f1cb70fea53cef0632f6b"
_REQUIRED_OPTIONS = (
    "--env",
    "--model",
    "--model-provider",
    "--user-model",
    "--user-model-provider",
    "--num-trials",
    "--seed",
    "--log-dir",
)


def _option_value(arguments: list[str], option: str) -> str | None:
    prefix = f"{option}="
    for index, argument in enumerate(arguments):
        if argument.startswith(prefix):
            return argument[len(prefix) :]
        if argument == option:
            return arguments[index + 1] if index + 1 < len(arguments) else None
    return None


def _require_pinned_checkout(checkout: Path, arguments: list[str]) -> Path:
    entrypoint = checkout / "run.py"
    if not entrypoint.is_file():
        raise SystemExit(
            "Run this adapter from the root of the pinned tau-bench checkout."
        )
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=checkout,
        check=False,
        capture_output=True,
        text=True,
    )
    revision = completed.stdout.strip() if completed.returncode == 0 else ""
    if revision != TAU_BENCH_REVISION:
        raise SystemExit(
            f"Unsupported tau-bench revision {revision!r}; expected "
            f"{TAU_BENCH_REVISION}."
        )
    if any(argument in ("-h", "--help") for argument in arguments):
        return entrypoint
    missing = [
        option for option in _REQUIRED_OPTIONS
        if _option_value(arguments, option) in (None, "")
    ]
    if missing:
        raise SystemExit(
            "Reproducible runs require explicit " + ", ".join(missing) + "."
        )
    strategy = _option_value(arguments, "--agent-strategy")
    if strategy != "tool-calling":
        raise SystemExit("Pass --agent-strategy tool-calling to run this wrapper.")
    return entrypoint


def _agent_factory(
    tools_info: list[dict[str, Any]], wiki: str, config: Any
) -> LhicTauBenchAgent:
    return LhicTauBenchAgent(
        tools_info=tools_info,
        wiki=wiki,
        model=config.model,
        provider=config.model_provider,
        temperature=config.temperature,
    )


def _write_manifest(config: Any) -> None:
    log_dir = Path(config.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    manifest = {
        "adapter": "lhic_tau_bench_agent",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "upstream_revision": TAU_BENCH_REVISION,
        "config": config.model_dump(mode="json"),
    }
    destination = log_dir / "lhic-run-manifest.json"
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(destination)


def main() -> None:
    entrypoint = _require_pinned_checkout(Path.cwd(), sys.argv[1:])
    upstream = importlib.import_module("tau_bench.run")
    upstream.agent_factory = _agent_factory
    upstream_run = upstream.run

    def checked_run(config: Any) -> Any:
        _write_manifest(config)
        results = upstream_run(config)
        failed = [result for result in results if result.info.get("error")]
        if failed:
            task_ids = ", ".join(str(result.task_id) for result in failed)
            raise RuntimeError(
                f"{len(failed)} simulation(s) failed; results were saved; "
                f"task ids: {task_ids}"
            )
        return results

    upstream.run = checked_run
    runpy.run_path(str(entrypoint), run_name="__main__")


if __name__ == "__main__":
    main()
