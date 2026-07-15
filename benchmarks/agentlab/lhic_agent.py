"""AgentLab bridge for LHIC's deterministic semantic-BID policy.

This is an intentionally narrow debug adapter. It exposes only low-risk search
and single-field-fill policies in ``lhic_semantic_policy`` and reports all
other tasks as infeasible. Do not use it for a full-suite or leaderboard
submission.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import bgym
from agentlab.agents.agent_args import AgentArgs

from lhic_semantic_policy import ActionPhase, propose_action


@dataclass
class LhicSemanticAgentArgs(AgentArgs):
    agent_name: str = "LhicSemanticBidAgent"

    def make_agent(self) -> bgym.Agent:
        return LhicSemanticAgent()

    def set_reproducibility_mode(self) -> None:
        return None

    def prepare(self) -> None:
        return None

    def close(self) -> None:
        return None


class LhicSemanticAgent(bgym.Agent):
    def __init__(self) -> None:
        self._phase_by_goal: dict[str, ActionPhase] = {}
        self.action_set = bgym.HighLevelActionSet(["bid", "infeas"], multiaction=False)

    def get_action(self, obs: Any) -> tuple[str, dict[str, Any]]:
        goal = str(obs.get("goal", ""))
        pruned_html = str(obs.get("pruned_html", ""))
        phase = self._phase_by_goal.get(goal, "initial")
        decision = propose_action(goal, pruned_html, phase)
        self._phase_by_goal[goal] = decision.phase
        return (
            decision.action,
            bgym.AgentInfo(
                think=decision.reason,
                stats={"lhic_semantic_policy": 1},
                extra_info={"phase": decision.phase},
            ),
        )
