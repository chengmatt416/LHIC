"""Run a pinned, full AgentLab benchmark study and write a reviewable manifest.

The runner intentionally has no task-filter option. A run is either the full
published benchmark named by ``--benchmark`` or it is not a comparable run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, distributions, version
from pathlib import Path
from typing import Any, Callable, Sequence


SUPPORTED_BENCHMARKS = ("workarena_l1", "workarena_l2", "workarena_l3", "webarena")
SUPPORTED_BACKENDS = ("sequential", "joblib", "ray")
STUDY_COMMENT = "LHIC model-backed full-suite evaluation"


@dataclass(frozen=True)
class StudyConfig:
    benchmark: str
    seed: int
    jobs: int
    backend: str
    relaunches: int
    strict_reproducibility: bool
    output_dir: Path
    max_steps: int | None
    agent: str = "full"
    model: str = ""
    model_base_url: str = "https://api.openai.com/v1"
    model_api_key_env: str = "OPENAI_API_KEY"
    model_temperature: float = 0.0
    model_timeout_seconds: float = 60.0
    model_max_observation_chars: int = 120_000
    model_max_attempts: int = 2
    agent_max_steps: int = 50
    semantic_fast_path: bool = True


def parse_args(arguments: Sequence[str] | None = None) -> StudyConfig:
    parser = argparse.ArgumentParser(
        description="Run a full, pinned LHIC AgentLab benchmark study."
    )
    parser.add_argument("--benchmark", choices=SUPPORTED_BENCHMARKS, required=True)
    parser.add_argument(
        "--agent",
        choices=("full", "semantic"),
        default="full",
        help="Agent implementation; the formal runner defaults to the model-backed full agent.",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("LHIC_MODEL", ""),
        help="Model identifier for --agent full (or LHIC_MODEL).",
    )
    parser.add_argument(
        "--model-base-url",
        default=os.environ.get("LHIC_MODEL_BASE_URL", "https://api.openai.com/v1"),
        help="OpenAI-compatible endpoint root (or LHIC_MODEL_BASE_URL).",
    )
    parser.add_argument(
        "--model-api-key-env",
        default=os.environ.get("LHIC_MODEL_API_KEY_ENV", "OPENAI_API_KEY"),
        help="Name of the credential environment variable; its value is never recorded.",
    )
    parser.add_argument("--model-temperature", type=float, default=0.0)
    parser.add_argument("--model-timeout-seconds", type=float, default=60.0)
    parser.add_argument(
        "--model-max-observation-chars", type=_positive_integer, default=120_000
    )
    parser.add_argument(
        "--model-max-attempts", type=_positive_integer, choices=(1, 2, 3), default=2
    )
    parser.add_argument("--agent-max-steps", type=_positive_integer, default=50)
    parser.add_argument(
        "--semantic-fast-path",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Try the schema-safe deterministic semantic planner before the model.",
    )
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--jobs", type=_positive_integer, default=1)
    parser.add_argument("--backend", choices=SUPPORTED_BACKENDS, default="sequential")
    parser.add_argument("--relaunches", type=_positive_integer, default=1)
    parser.add_argument(
        "--strict-reproducibility",
        action="store_true",
        help="Ask AgentLab to reject incompatible source changes when supported.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(os.environ.get("AGENTLAB_EXP_ROOT", "/results")),
    )
    parser.add_argument(
        "--max-steps",
        type=_positive_integer,
        help="Optional debug-only override; omit for protocol-comparable full runs.",
    )
    parsed = parser.parse_args(arguments)
    return StudyConfig(
        seed=parsed.seed,
        benchmark=parsed.benchmark,
        jobs=parsed.jobs,
        backend=parsed.backend,
        relaunches=parsed.relaunches,
        strict_reproducibility=parsed.strict_reproducibility,
        output_dir=parsed.output_dir,
        max_steps=parsed.max_steps,
        agent=parsed.agent,
        model=parsed.model,
        model_base_url=parsed.model_base_url,
        model_api_key_env=parsed.model_api_key_env,
        model_temperature=parsed.model_temperature,
        model_timeout_seconds=parsed.model_timeout_seconds,
        model_max_observation_chars=parsed.model_max_observation_chars,
        model_max_attempts=parsed.model_max_attempts,
        agent_max_steps=parsed.agent_max_steps,
        semantic_fast_path=parsed.semantic_fast_path,
    )


def run_study(
    config: StudyConfig,
    make_study: Callable[..., Any],
    agent_args: Any,
) -> Path:
    """Run the full study and return its immutable-on-write manifest path."""

    _validate_comparable_run_config(config)
    config.output_dir.mkdir(parents=True, exist_ok=True)
    random.seed(config.seed)
    started_at = _utc_now()
    study = make_study(
        benchmark=config.benchmark,
        agent_args=[agent_args],
        comment=STUDY_COMMENT,
    )
    if config.max_steps is not None:
        study.override_max_steps(config.max_steps)
    study.run(
        n_jobs=config.jobs,
        parallel_backend=config.backend,
        strict_reproducibility=config.strict_reproducibility,
        n_relaunch=config.relaunches,
        exp_root=config.output_dir,
    )
    study_outcome = _validate_study_results(study)
    study_dir = Path(study.dir)
    if not study_dir.is_dir():
        raise RuntimeError("AgentLab did not create a study directory.")
    return _write_manifest(
        study_dir=study_dir,
        config=config,
        study_outcome=study_outcome,
        started_at=started_at,
        completed_at=_utc_now(),
    )


def main(arguments: Sequence[str] | None = None) -> None:
    config = parse_args(arguments)
    from agentlab.experiments.study import make_study

    agent_args = _make_agent_args(config)
    manifest = run_study(config, make_study, agent_args)
    print(json.dumps({"manifest": str(manifest)}, sort_keys=True))


def _make_agent_args(config: StudyConfig) -> Any:
    if config.agent == "semantic":
        from lhic_agent import LhicSemanticAgentArgs

        return LhicSemanticAgentArgs()
    from lhic_full_agent import LhicFullAgentArgs

    agent_args = LhicFullAgentArgs(
        model=config.model,
        model_base_url=config.model_base_url,
        model_api_key_env=config.model_api_key_env,
        seed=config.seed,
        temperature=config.model_temperature,
        request_timeout_seconds=config.model_timeout_seconds,
        max_observation_chars=config.model_max_observation_chars,
        max_planner_attempts=config.model_max_attempts,
        max_steps=config.agent_max_steps,
        enable_semantic_fast_path=config.semantic_fast_path,
    )
    agent_args.validate()
    return agent_args


def _write_manifest(
    study_dir: Path,
    config: StudyConfig,
    study_outcome: dict[str, int],
    started_at: str,
    completed_at: str,
) -> Path:
    files = _hash_study_files(study_dir)
    manifest = {
        "schemaVersion": 1,
        "purpose": "external-benchmark-study",
        "startedAt": started_at,
        "completedAt": completed_at,
        "config": {
            **asdict(config),
            "output_dir": str(config.output_dir),
        },
        "outcome": study_outcome,
        "runtime": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "agentlab": _package_version("agentlab"),
            "browsergym": _package_version("browsergym"),
            "browsergymWorkarena": _package_version("browsergym-workarena"),
            "browsergymWebarena": _package_version("browsergym-webarena"),
            "lhicSourceRevision": os.environ.get("LHIC_SOURCE_REVISION", "unknown"),
            "imageDigest": os.environ.get("LHIC_IMAGE_DIGEST", "unknown"),
            "pythonPackages": collect_installed_python_packages(),
            "pythonPackagesSha256": installed_python_packages_sha256(),
        },
        "files": files,
        "secretValuesRecorded": False,
    }
    path = study_dir / "lhic-study-manifest.json"
    with path.open("x", encoding="utf-8") as manifest_file:
        json.dump(manifest, manifest_file, indent=2, sort_keys=True)
        manifest_file.write("\n")
    return path


def _validate_study_results(study: Any) -> dict[str, int]:
    """Fail closed when AgentLab returns with errored or incomplete experiments."""

    expected = _expected_experiment_count(study)
    if expected < 1:
        raise RuntimeError("AgentLab study contains no benchmark experiments.")
    result_frame, _summary_frame, _error_report = study.get_results(also_save=True)
    records = result_frame.to_dict(orient="records")
    if len(records) != expected:
        raise RuntimeError(
            "AgentLab study is incomplete: "
            f"expected {expected} experiment results, found {len(records)}."
        )
    errored = sum(
        1
        for record in records
        if not _is_missing_result_value(record.get("err_msg"))
        and record.get("err_msg") != ""
    )
    missing_rewards = sum(
        1
        for record in records
        if _is_missing_result_value(record.get("cum_reward"))
    )
    if errored or missing_rewards:
        raise RuntimeError(
            "AgentLab study did not complete successfully: "
            f"{errored} errored and {missing_rewards} missing-reward experiments."
        )
    return {
        "expectedExperiments": expected,
        "completedExperiments": len(records),
        "erroredExperiments": 0,
    }


def _expected_experiment_count(study: Any) -> int:
    nested_studies = getattr(study, "studies", None)
    if nested_studies is not None:
        return sum(_expected_experiment_count(nested) for nested in nested_studies)
    experiments = getattr(study, "exp_args_list", None)
    return len(experiments) if experiments is not None else 0


def _is_missing_result_value(value: Any) -> bool:
    if value is None:
        return True
    try:
        return bool(value != value)
    except (TypeError, ValueError):
        return False


def _hash_study_files(study_dir: Path) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    for path in sorted(study_dir.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(
                f"Study artifact must not be a symbolic link: {path.relative_to(study_dir)}"
            )
        if not path.is_file() or path.name == "lhic-study-manifest.json":
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        files.append({"path": str(path.relative_to(study_dir)), "sha256": digest})
    return files


def _validate_comparable_run_config(config: StudyConfig) -> None:
    """Reject configuration that would falsely look like a strict full-suite run."""

    if not config.strict_reproducibility:
        return
    if config.max_steps is not None:
        raise ValueError(
            "--max-steps changes the benchmark protocol; omit it for strict runs."
        )
    if config.agent == "full" and config.model_temperature != 0:
        raise ValueError(
            "Strict full-agent runs require --model-temperature 0."
        )
    source_revision = os.environ.get("LHIC_SOURCE_REVISION", "unknown")
    if not _is_git_revision(source_revision):
        raise ValueError(
            "Strict runs require a committed LHIC_SOURCE_REVISION build argument."
        )
    image_digest = os.environ.get("LHIC_IMAGE_DIGEST", "unknown")
    if not _is_image_digest(image_digest):
        raise ValueError(
            "Strict runs require an immutable LHIC_IMAGE_DIGEST runtime value."
        )


def _is_git_revision(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{7,64}", value))


def _is_image_digest(value: str) -> bool:
    return bool(re.fullmatch(r"sha256:[0-9a-fA-F]{64}", value))


def _package_version(distribution: str) -> str:
    try:
        return version(distribution)
    except PackageNotFoundError:
        return "not-installed"


def collect_installed_python_packages() -> list[str]:
    """Return a stable, secret-free inventory of every installed distribution."""

    packages: dict[str, str] = {}
    for distribution in distributions():
        name = distribution.metadata.get("Name")
        if name:
            packages[name.lower()] = f"{name}=={distribution.version}"
    return [packages[name] for name in sorted(packages)]


def installed_python_packages_sha256() -> str:
    inventory = "\n".join(collect_installed_python_packages()).encode("utf-8")
    return hashlib.sha256(inventory).hexdigest()


def _positive_integer(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


if __name__ == "__main__":
    main()
