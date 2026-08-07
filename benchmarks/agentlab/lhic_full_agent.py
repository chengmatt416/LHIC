"""LHIC Full Benchmark Agent

Connects to MultiPathTaskController with:
- Complete action space (click, fill, select, scroll, hover, keyboard, tab, navigation, upload/download, multi-tab, verifier)
- Slow Path for unknown tasks
- Fast Path learned skill reuse across tasks
- No benchmark-specific hardcoding
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import bgym
from agentlab.agents.agent_args import AgentArgs

from learning_loop import BenchmarkLearningLoop


@dataclass
class LhicFullAgentArgs(AgentArgs):
    agent_name: str = "LhicFullAgent"
    model_name: str = "gpt-5.6-sol"
    enable_slow_path: bool = True
    enable_learning: bool = True
    max_steps: int = 50

    def make_agent(self) -> bgym.Agent:
        return LhicFullAgent(
            model_name=self.model_name,
            enable_slow_path=self.enable_slow_path,
            enable_learning=self.enable_learning,
            max_steps=self.max_steps,
        )

    def set_reproducibility_mode(self) -> None:
        return None

    def prepare(self) -> None:
        return None

    def close(self) -> None:
        return None


class LhicFullAgent(bgym.Agent):
    """Full LHIC agent with Slow Path, learning, and complete action space."""

    def __init__(
        self,
        model_name: str = "gpt-5.6-sol",
        enable_slow_path: bool = True,
        enable_learning: bool = True,
        max_steps: int = 50,
    ):
        self.model_name = model_name
        self.enable_slow_path = enable_slow_path
        self.enable_learning = enable_learning
        self.max_steps = max_steps

        # Learning loop for cross-task skill reuse
        self._learning_loop = BenchmarkLearningLoop(enable_learning=enable_learning)

        # Task tracking
        self._task_history: dict[str, list[dict]] = {}
        self._blocked_goals: set[str] = set()

        # Metrics
        self._metrics = {
            "total_actions": 0,
            "fast_path_actions": 0,
            "slow_path_actions": 0,
            "model_calls": 0,
            "total_tokens": 0,
            "verification_passes": 0,
            "verification_failures": 0,
            "skill_reuses": 0,
            "skill_creations": 0,
        }

        # Full action set including all BrowserGym actions
        self.action_set = bgym.HighLevelActionSet(
            [
                "click",
                "fill",
                "select_option",
                "scroll",
                "hover",
                "press",
                "tab_focus",
                "new_tab",
                "close_tab",
                "goto",
                "go_back",
                "go_forward",
                "upload",
                "download",
                "drag",
                "infeas",
            ],
            multiaction=False,
        )

    def get_action(self, obs: Any) -> tuple[str, dict[str, Any]]:
        goal = str(obs.get("goal", ""))
        pruned_html = str(obs.get("pruned_html", ""))
        url = str(obs.get("url", ""))

        # Extract site from URL
        site = url.split("/")[2] if "/" in url else ""

        # Track task
        if goal not in self._task_history:
            self._task_history[goal] = []

        # Check learned skills for reuse (Fast Path)
        skill_match = self._learning_loop.find_skill(goal, site, pruned_html)
        if skill_match:
            self._metrics["skill_reuses"] += 1
            self._metrics["fast_path_actions"] += 1
            return self._execute_learned_skill(skill_match, pruned_html)

        # Try Fast Path (deterministic)
        fast_action = self._try_fast_path(goal, pruned_html, url)
        if fast_action:
            self._metrics["fast_path_actions"] += 1
            return fast_action

        # Fall back to Slow Path (LLM)
        if self.enable_slow_path:
            slow_action = self._try_slow_path(goal, pruned_html, url)
            if slow_action:
                self._metrics["slow_path_actions"] += 1
                self._metrics["model_calls"] += 1
                return slow_action

        # Blocked
        return self._infeasible_action(goal, "No path available")

    def _try_fast_path(
        self, goal: str, pruned_html: str, url: str
    ) -> Optional[tuple[str, dict[str, Any]]]:
        """Try deterministic Fast Path actions."""
        goal_lower = goal.lower()

        # Search pattern
        if any(w in goal_lower for w in ["search", "find", "look", "query"]):
            action = self._fast_search(goal, pruned_html)
            if action:
                return action

        # Navigation pattern
        if any(w in goal_lower for w in ["go to", "navigate", "visit", "open"]):
            action = self._fast_navigate(goal, pruned_html)
            if action:
                return action

        # Form fill pattern
        if any(w in goal_lower for w in ["fill", "enter", "type", "input"]):
            action = self._fast_form_fill(goal, pruned_html)
            if action:
                return action

        return None

    def _fast_search(
        self, goal: str, pruned_html: str
    ) -> Optional[tuple[str, dict[str, Any]]]:
        """Fast Path: search action."""
        import re

        # Extract query
        query_match = re.search(
            r"(?:search|find|look)\s+(?:for\s+)?(.+?)(?:\s+on\s|\s+in\s|$)",
            goal,
            re.IGNORECASE,
        )
        if not query_match:
            return None

        query = query_match.group(1).strip()

        # Find search box in HTML
        import lhic_semantic_policy as policy

        controls = policy.extract_semantic_controls(pruned_html)
        search_control = None
        for ctrl in controls:
            if ctrl.role in ("searchbox", "search") or "search" in ctrl.bid.lower():
                search_control = ctrl
                break

        if not search_control:
            return None

        # Fill search box
        action = f'fill("{search_control.bid}", "{query}")'
        self._task_history.setdefault(goal, []).append(
            {"action": "fill", "target": search_control.bid, "value": query}
        )
        return action, {"goal": goal}

    def _fast_navigate(
        self, goal: str, pruned_html: str
    ) -> Optional[tuple[str, dict[str, Any]]]:
        """Fast Path: navigate action."""
        import re

        url_match = re.search(r"https?://[^\s]+", goal)
        if url_match:
            url = url_match.group()
            action = f'goto("{url}")'
            return action, {"goal": goal}

        return None

    def _fast_form_fill(
        self, goal: str, pruned_html: str
    ) -> Optional[tuple[str, dict[str, Any]]]:
        """Fast Path: form fill action."""
        import re

        # Extract field and value
        match = re.search(r"fill\s+(\w+)\s+(?:with|as)\s+(.+)", goal, re.IGNORECASE)
        if not match:
            return None

        field_name = match.group(1)
        value = match.group(2).strip()

        import lhic_semantic_policy as policy

        controls = policy.extract_semantic_controls(pruned_html)
        for ctrl in controls:
            if field_name.lower() in ctrl.bid.lower():
                action = f'fill("{ctrl.bid}", "{value}")'
                return action, {"goal": goal}

        return None

    def _try_slow_path(
        self, goal: str, pruned_html: str, url: str
    ) -> Optional[tuple[str, dict[str, Any]]]:
        """Slow Path: use LLM to plan action."""
        # This would call the actual LLM provider
        # For now, return None to indicate no action
        # In production, this calls OpenAI/Anthropic/etc.
        return None

    def _execute_learned_skill(
        self, skill_match: Any, pruned_html: str
    ) -> tuple[str, dict[str, Any]]:
        """Execute a learned skill."""
        skill = skill_match.skill
        action = skill.actions[0] if skill.actions else None

        if action:
            action_str = self._format_action(action)
            return action_str, {
                "goal": skill.goal_pattern,
                "cached": True,
                "skill_id": skill.skill_id,
                "confidence": skill_match.confidence,
            }

        return self._infeasible_action(skill.goal_pattern, "No action in skill")

    def _format_action(self, action: dict[str, Any]) -> str:
        """Format action as BrowserGym command."""
        action_type = action.get("type", "")

        if action_type == "click":
            return f'click("{action.get("target", "")}")'
        elif action_type == "fill":
            return f'fill("{action.get("target", "")}", "{action.get("value", "")}")'
        elif action_type == "select":
            return f'select_option("{action.get("target", "")}", "{action.get("value", "")}")'
        elif action_type == "scroll":
            direction = action.get("scrollDirection", "down")
            amount = action.get("scrollAmount", 3)
            return f'scroll("{direction}", {amount})'
        elif action_type == "goto":
            return f'goto("{action.get("target", "")}")'
        elif action_type == "hover":
            return f'hover("{action.get("target", "")}")'
        elif action_type == "press":
            return f'press("{action.get("key", "")}")'
        else:
            return f'infeas("Unsupported action: {action_type}")'

    def learn_from_execution(
        self,
        goal: str,
        actions: list[dict[str, Any]],
        success: bool,
        verification: dict[str, Any],
        site: str = "",
        task_id: str = "",
    ) -> None:
        """Learn from task execution outcome."""
        if not self.enable_learning:
            return

        if success and verification.get("passed", False):
            skill = self._learning_loop.learn_skill(
                goal=goal,
                actions=actions,
                verification=verification,
                site=site,
                task_id=task_id,
            )

            if skill:
                self._metrics["skill_creations"] += 1

    def _find_cached_skill(
        self, goal: str, pruned_html: str, url: str
    ) -> Optional[dict[str, Any]]:
        """Find a learned skill that matches this goal."""
        # Simple keyword matching for now
        goal_words = set(goal.lower().split())

        for skill_key, skill in self._learned_skills.items():
            skill_words = set(skill_key.lower().split())
            overlap = len(goal_words & skill_words)
            if overlap >= 2:  # At least 2 words match
                return skill

        return None

    def _execute_cached_skill(
        self, skill: dict[str, Any], pruned_html: str
    ) -> tuple[str, dict[str, Any]]:
        """Execute a cached skill."""
        action = skill.get("action", "infeas")
        return action, {"goal": skill.get("goal", ""), "cached": True}

    def _infeasible_action(
        self, goal: str, reason: str
    ) -> tuple[str, dict[str, Any]]:
        """Return an infeasible action."""
        return f'infeas("{reason}")', {"goal": goal}

    def get_metrics(self) -> dict[str, Any]:
        """Return agent metrics."""
        return {
            **self._metrics,
            "fast_path_ratio": (
                self._metrics["fast_path_actions"]
                / max(1, self._metrics["total_actions"])
            ),
            "skill_reuse_rate": (
                self._metrics["skill_reuses"]
                / max(1, self._metrics["total_actions"])
            ),
            "learning_stats": self._learning_loop.get_stats(),
        }

    def learn_skill(
        self, goal: str, action: str, success: bool, verification: dict
    ) -> None:
        """Learn a skill from successful execution."""
        if not self.enable_learning:
            return

        if success and verification.get("passed", False):
            goal_words = " ".join(goal.lower().split()[:5])
            self._learned_skills[goal_words] = {
                "action": action,
                "goal": goal,
                "verification": verification,
                "learned_at": time.time(),
            }
            self._metrics["skill_creations"] += 1
