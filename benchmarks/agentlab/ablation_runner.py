"""Fail-closed tombstone for the retired synthetic ablation runner.

This file used to emit placeholder zero-valued metrics after an AgentLab run.
Those values were not benchmark results, so the entry point must not produce an
artifact or report success.
"""

from __future__ import annotations

import sys


GUIDANCE = """\
benchmarks/agentlab/ablation_runner.py is retired because it cannot derive
real task outcomes from AgentLab and previously emitted placeholder metrics.

For a full external WebArena/WorkArena study, use the pinned AgentLab runner:
  python benchmarks/agentlab/run_study.py --benchmark webarena --seed 0 \
--jobs 1 --backend sequential --relaunches 1 --strict-reproducibility

For the controlled local regression benchmark, use:
  npm run bench:internal

See benchmarks/README.md and benchmarks/agentlab/README.md for required
environment, revision, image-digest, and result-artifact configuration.
"""


def main() -> None:
    print(GUIDANCE, file=sys.stderr)
    raise SystemExit(2)


if __name__ == "__main__":
    main()
