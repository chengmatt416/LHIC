"""Verify the pinned AgentLab runner without inspecting secrets."""

from __future__ import annotations

import json
import sys
from importlib.metadata import version

from run_study import installed_python_packages_sha256


def main() -> None:
    import agentlab  # noqa: F401
    import browsergym  # noqa: F401
    import browsergym.webarena  # noqa: F401
    from agentlab.experiments.study import make_study
    from lhic_agent import LhicSemanticAgentArgs
    from lhic_full_agent import LhicFullAgentArgs
    from playwright.sync_api import sync_playwright

    agent_args = LhicSemanticAgentArgs()
    full_agent_args = LhicFullAgentArgs(model="preflight-no-request")
    study = make_study(
        benchmark="workarena_l1",
        agent_args=[agent_args],
        comment="LHIC adapter preflight; no benchmark execution.",
    )
    task_count = len(study.exp_args_list)
    if task_count == 0:
        raise RuntimeError("AgentLab produced no WorkArena L1 experiments.")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        browser.close()

    print(
        json.dumps(
            {
                "passed": True,
                "purpose": "agentlab-adapter-api-preflight",
                "python": sys.version.split()[0],
                "agentlab": version("agentlab"),
                "browsergym": version("browsergym"),
                "browsergymWorkarena": version("browsergym-workarena"),
                "browsergymWebarena": version("browsergym-webarena"),
                "playwright": version("playwright"),
                "pythonPackagesSha256": installed_python_packages_sha256(),
                "lhicAgentAdapter": agent_args.agent_name,
                "lhicFullAgentAdapter": full_agent_args.agent_name,
                "workarenaL1StudyTaskCount": task_count,
                "secretValuesInspected": False,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
