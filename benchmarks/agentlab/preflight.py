"""Verify the pinned AgentLab runner without inspecting secrets."""

from __future__ import annotations

import json
import sys
from importlib.metadata import version


def main() -> None:
    import agentlab  # noqa: F401
    import browsergym  # noqa: F401
    from lhic_agent import LhicSemanticAgentArgs
    from playwright.sync_api import sync_playwright

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
                "browsergymCore": version("browsergym-core"),
                "browsergymExperiments": version("browsergym-experiments"),
                "playwright": version("playwright"),
                "lhicAgentAdapter": LhicSemanticAgentArgs().agent_name,
                "secretValuesInspected": False,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
