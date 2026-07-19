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
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, distributions, version
from pathlib import Path
from typing import Any, Callable, Sequence


SUPPORTED_BENCHMARKS = ("workarena_l1", "workarena_l2", "workarena_l3", "webarena")
SUPPORTED_BACKENDS = ("sequential", "joblib", "ray")
STUDY_COMMENT = "LHIC semantic-BID full-suite evaluation"


@dataclass(frozen=True)
class StudyConfig:
    benchmark: str
    jobs: int
    backend: str
    relaunches: int
    strict_reproducibility: bool
    output_dir: Path
    max_steps: int | None


def parse_args(arguments: Sequence[str] | None = None) -> StudyConfig:
    parser = argparse.ArgumentParser(
        description="Run a full, pinned LHIC AgentLab benchmark study."
    )
    parser.add_argument("--benchmark", choices=SUPPORTED_BENCHMARKS, required=True)
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
        benchmark=parsed.benchmark,
        jobs=parsed.jobs,
        backend=parsed.backend,
        relaunches=parsed.relaunches,
        strict_reproducibility=parsed.strict_reproducibility,
        output_dir=parsed.output_dir,
        max_steps=parsed.max_steps,
    )


def run_study(
    config: StudyConfig,
    make_study: Callable[..., Any],
    agent_args: Any,
) -> Path:
    """Run the full study and return its immutable-on-write manifest path."""

    _validate_comparable_run_config(config)
    config.output_dir.mkdir(parents=True, exist_ok=True)
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
    study_dir = Path(study.dir)
    if not study_dir.is_dir():
        raise RuntimeError("AgentLab did not create a study directory.")
    return _write_manifest(
        study_dir=study_dir,
        config=config,
        started_at=started_at,
        completed_at=_utc_now(),
    )


def main(arguments: Sequence[str] | None = None) -> None:
    config = parse_args(arguments)
    from agentlab.experiments.study import make_study
    from lhic_agent import LhicSemanticAgentArgs

    manifest = run_study(config, make_study, LhicSemanticAgentArgs())
    print(json.dumps({"manifest": str(manifest)}, sort_keys=True))


def _write_manifest(
    study_dir: Path,
    config: StudyConfig,
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
        "runtime": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "agentlab": _package_version("agentlab"),
            "browsergym": _package_version("browsergym"),
            "browsergymWorkarena": _package_version("browsergym-workarena"),
            "lhicSourceRevision": os.environ.get("LHIC_SOURCE_REVISION", "unknown"),
            "imageDigest": os.environ.get("LHIC_IMAGE_DIGEST", "unknown"),
            "pythonPackages": collect_installed_python_packages(),
            "pythonPackagesSha256": installed_python_packages_sha256(),
        },
        "files": files,
        "secretValuesInspected": False,
    }
    path = study_dir / "lhic-study-manifest.json"
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def _hash_study_files(study_dir: Path) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    for path in sorted(study_dir.rglob("*")):
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
