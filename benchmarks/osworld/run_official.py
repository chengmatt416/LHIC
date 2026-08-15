"""Launch the pinned official OSWorld 2.0 runner with the LHIC agent class."""

from __future__ import annotations

import argparse
import importlib
import os
from pathlib import Path
import runpy
import sys

from lhic_osworld_agent import LHICOSWorldAgent


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--osworld-root", required=True)
    parser.add_argument("--benchmark-revision", required=True)
    known, official_args = parser.parse_known_args()
    root = Path(known.osworld_root).resolve()
    runner = root / "run.py"
    release_manifest = root / "benchmark_releases" / f"{known.benchmark_revision}.json"
    if not runner.is_file():
        raise SystemExit(f"Official OSWorld run.py not found under {root}.")
    if not release_manifest.is_file():
        raise SystemExit(
            f"Pinned benchmark release manifest not found: {release_manifest}."
        )
    configured_revision = os.environ.get("LHIC_OSWORLD_BENCHMARK_REVISION")
    if configured_revision != known.benchmark_revision:
        raise SystemExit(
            "--benchmark-revision must equal LHIC_OSWORLD_BENCHMARK_REVISION."
        )
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    os.chdir(root)
    agent_module = importlib.import_module("mm_agents.agent")
    agent_module.PromptAgent = LHICOSWorldAgent
    sys.argv = [str(runner), *official_args]
    runpy.run_path(str(runner), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
