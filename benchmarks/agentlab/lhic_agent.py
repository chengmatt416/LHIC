"""AgentLab bridge for LHIC's deterministic semantic-BID policy.

It exposes explicit, low-risk semantic interactions, HTTP(S) navigation, and a
bounded recovery path for idempotent actions. Unsupported or ambiguous tasks
remain fail-closed; do not use it for a leaderboard submission until external
evidence exists.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import bgym
from agentlab.agents.agent_args import AgentArgs

from lhic_semantic_policy import PlanState, propose_plan_action


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


@dataclass(frozen=True)
class _PendingAction:
    action: str
    prior_state: PlanState
    recovery_attempted: bool = False


class LhicSemanticAgent(bgym.Agent):
    def __init__(self) -> None:
        self._plan_state_by_goal: dict[tuple[str, str], PlanState] = {}
        self._pending_action_by_goal: dict[tuple[str, str], _PendingAction] = {}
        self._blocked_goals: set[tuple[str, str]] = set()
        self._blocked_reasons: dict[tuple[str, str], str] = {}
        self._action_count = 0
        self._recovery_count = 0
        self._action_error_count = 0
        self.action_set = bgym.HighLevelActionSet(
            ["bid", "nav", "infeas"], multiaction=False
        )

    def get_action(self, obs: Any) -> tuple[str, dict[str, Any]]:
        goal = str(obs.get("goal", ""))
        task_id = str(obs.get("task_id") or obs.get("taskId") or "")
        goal_key = (task_id, goal)
        pruned_html = str(obs.get("pruned_html", ""))
        if goal_key in self._blocked_goals:
            return self._blocked_action(goal_key, goal)

        pending = self._pending_action_by_goal.get(goal_key)
        action_error = _action_error_message(obs.get("last_action_error"))
        if action_error is not None:
            self._action_error_count += 1
            if (
                pending is not None
                and not pending.recovery_attempted
                and pending.action.startswith(("fill(", "select_option("))
            ):
                recovery = propose_plan_action(goal, pruned_html, pending.prior_state)
                recovery_action = recovery.decision.action
                if not recovery_action.startswith(("noop(", "report_infeasible(")):
                    self._plan_state_by_goal[goal_key] = recovery.next_state
                    self._pending_action_by_goal[goal_key] = _PendingAction(
                        action=recovery_action,
                        prior_state=pending.prior_state,
                        recovery_attempted=True,
                    )
                    self._action_count += 1
                    self._recovery_count += 1
                    return (
                        recovery_action,
                        bgym.AgentInfo(
                            think=(
                                f"Rebound an idempotent semantic action after "
                                f"BrowserGym reported: {action_error}"
                            ),
                            stats={
                                "lhic_semantic_policy": 1,
                                "plan_steps": recovery.step_count,
                                "action_errors": self._action_error_count,
                                "recoveries": self._recovery_count,
                                "actions": self._action_count,
                            },
                            extra_info={
                                "phase": recovery.decision.phase,
                                "stepIndex": pending.prior_state.step_index,
                                "completed": recovery.completed,
                                "recoveredFromActionError": True,
                            },
                        ),
                    )
            return self._block_goal(
                goal_key,
                goal,
                "A browser action failed and no safe bounded recovery remained: "
                f"{action_error}",
            )

        if pending is not None:
            if obs.get("last_action") != pending.action:
                return self._block_goal(
                    goal_key,
                    goal,
                    "The previous browser action was not echoed by BrowserGym; the "
                    "deterministic adapter stopped this goal rather than advancing "
                    "without an execution receipt.",
                )
            del self._pending_action_by_goal[goal_key]

        state = self._plan_state_by_goal.get(goal_key, PlanState())
        plan = propose_plan_action(goal, pruned_html, state)
        self._plan_state_by_goal[goal_key] = plan.next_state
        if not plan.decision.action.startswith(("noop(", "report_infeasible(")):
            self._pending_action_by_goal[goal_key] = _PendingAction(
                action=plan.decision.action,
                prior_state=state,
            )
        self._action_count += 1
        return (
            plan.decision.action,
            bgym.AgentInfo(
                think=plan.decision.reason,
                stats={
                    "lhic_semantic_policy": 1,
                    "plan_steps": plan.step_count,
                    "action_errors": self._action_error_count,
                    "recoveries": self._recovery_count,
                    "actions": self._action_count,
                },
                extra_info={
                    "phase": plan.decision.phase,
                    "stepIndex": state.step_index,
                    "completed": plan.completed,
                    "taskIdPresent": bool(task_id),
                },
            ),
        )

    def _block_goal(
        self, goal_key: tuple[str, str], goal: str, reason: str
    ) -> tuple[str, dict[str, Any]]:
        self._blocked_goals.add(goal_key)
        self._blocked_reasons[goal_key] = reason
        self._pending_action_by_goal.pop(goal_key, None)
        return self._blocked_action(goal_key, goal)

    def _blocked_action(
        self, goal_key: tuple[str, str], goal: str
    ) -> tuple[str, dict[str, Any]]:
        reason = self._blocked_reasons.get(
            goal_key,
            "The deterministic adapter stopped this goal rather than retrying or "
            "advancing without verification.",
        )
        state = self._plan_state_by_goal.get(goal_key, PlanState())
        stats = {
            "lhic_semantic_policy": 1,
            "action_errors": self._action_error_count,
            "recoveries": self._recovery_count,
            "actions": self._action_count,
        }
        if reason.startswith("A browser action failed"):
            stats["action_error_blocked"] = 1
        return (
            f"report_infeasible({json.dumps(reason)})",
            bgym.AgentInfo(
                think=reason,
                stats=stats,
                extra_info={
                    "phase": state.phase,
                    "stepIndex": state.step_index,
                    "completed": False,
                    "blocked": True,
                    "goal": goal,
                },
            ),
        )


def _action_error_message(value: object) -> str | None:
    if value is None or value is False:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (dict, list, tuple, set)) and not value:
        return None
    return str(value)
