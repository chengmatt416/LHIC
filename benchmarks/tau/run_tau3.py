"""Run the LHIC agent through the pinned tau3-bench v1.0.1 CLI."""

from __future__ import annotations

import importlib.metadata
import subprocess
import sys
from pathlib import Path
from typing import Any


TAU2_VERSION = "1.0.1"
TAU2_REVISION = "fc0055dc4e0a316c3f83133267fbd6faaa770992"
AGENT_NAME = "lhic_policy_tool"
_REQUIRED_RUN_OPTIONS = ("--domain", "--agent-llm", "--num-trials", "--seed")
_FAILED_TERMINATIONS = {
    "agent_error",
    "user_error",
    "infrastructure_error",
    "context_window_exceeded",
    "unexpected_error",
    "timeout",
    "too_many_errors",
}


def _checkout_revision(checkout: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=checkout,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise SystemExit(
            "run_tau3.py must be launched from the root of the pinned "
            "tau2-bench v1.0.1 checkout."
        )
    return completed.stdout.strip()


def _require_pinned_upstream(checkout: Path) -> None:
    try:
        version = importlib.metadata.version("tau2")
    except importlib.metadata.PackageNotFoundError as error:
        raise SystemExit(
            "tau2 is not installed; install the pinned v1.0.1 checkout first."
        ) from error
    if version != TAU2_VERSION:
        raise SystemExit(
            f"Unsupported tau2 package version {version!r}; expected {TAU2_VERSION!r}."
        )
    revision = _checkout_revision(checkout)
    if revision != TAU2_REVISION:
        raise SystemExit(
            f"Unsupported tau2-bench revision {revision!r}; expected "
            f"v{TAU2_VERSION} commit {TAU2_REVISION}."
        )


def _option_value(arguments: list[str], option: str) -> str | None:
    prefix = f"{option}="
    for index, argument in enumerate(arguments):
        if argument.startswith(prefix):
            return argument[len(prefix) :]
        if argument == option:
            return arguments[index + 1] if index + 1 < len(arguments) else None
    return None


def _require_reproducible_run(arguments: list[str]) -> None:
    if not arguments or arguments[0] != "run":
        raise SystemExit("This wrapper only supports the tau2 'run' command.")
    if any(argument in ("-h", "--help") for argument in arguments):
        return
    if "--audio-native" in arguments:
        raise SystemExit("lhic_policy_tool is a text half-duplex agent.")
    missing = [
        option for option in _REQUIRED_RUN_OPTIONS
        if _option_value(arguments, option) in (None, "")
    ]
    if missing:
        raise SystemExit(
            "Reproducible runs require explicit " + ", ".join(missing) + "."
        )
    agent = _option_value(arguments, "--agent")
    if agent != AGENT_NAME:
        raise SystemExit(f"Pass --agent {AGENT_NAME} to run this wrapper.")


def _checked_run_domain(upstream_run_domain: Any, config: Any) -> Any:
    results = upstream_run_domain(config)
    failed = [
        simulation
        for simulation in results.simulations
        if getattr(simulation.termination_reason, "value", simulation.termination_reason)
        in _FAILED_TERMINATIONS
        or simulation.reward_info is None
    ]
    if failed:
        task_ids = ", ".join(str(simulation.task_id) for simulation in failed)
        raise RuntimeError(
            f"{len(failed)} simulation(s) failed; results were saved; task ids: {task_ids}"
        )
    return results


def main() -> None:
    checkout = Path.cwd()
    _require_pinned_upstream(checkout)
    _require_reproducible_run(sys.argv[1:])

    import tau2.cli as tau2_cli
    from tau2.registry import registry

    from lhic_tau3_agent import create_lhic_tau3_agent

    if registry.get_agent_factory(AGENT_NAME) is not None:
        raise RuntimeError(f"tau2 agent factory {AGENT_NAME!r} is already registered")
    registry.register_agent_factory(
        create_lhic_tau3_agent,
        AGENT_NAME,
        metadata={"description": "Policy- and schema-hardened sequential tool agent"},
    )
    upstream_run_domain = tau2_cli.run_domain
    tau2_cli.run_domain = lambda config: _checked_run_domain(
        upstream_run_domain, config
    )
    tau2_cli.main()


if __name__ == "__main__":
    main()
