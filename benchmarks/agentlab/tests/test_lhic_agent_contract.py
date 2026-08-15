import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class _FakeAgent:
    pass


class _FakeHighLevelActionSet:
    def __init__(self, subsets, multiaction):
        self.subsets = subsets
        self.multiaction = multiaction


class _FakeAgentArgs:
    pass


def _load_agent_module() -> types.ModuleType:
    bgym = types.ModuleType("bgym")
    bgym.Agent = _FakeAgent
    bgym.HighLevelActionSet = _FakeHighLevelActionSet
    bgym.AgentInfo = lambda **kwargs: kwargs

    agentlab = types.ModuleType("agentlab")
    agents = types.ModuleType("agentlab.agents")
    agent_args = types.ModuleType("agentlab.agents.agent_args")
    agent_args.AgentArgs = _FakeAgentArgs
    agentlab.agents = agents
    agents.agent_args = agent_args

    module = types.ModuleType("lhic_agent_contract")
    module.__file__ = str(Path(__file__).parents[1] / "lhic_agent.py")
    source = Path(module.__file__).read_text(encoding="utf-8")
    with patch.dict(
        sys.modules,
        {
            "bgym": bgym,
            "agentlab": agentlab,
            "agentlab.agents": agents,
            "agentlab.agents.agent_args": agent_args,
            module.__name__: module,
        },
    ):
        exec(compile(source, module.__file__, "exec"), module.__dict__)
    return module


class LhicAgentContractTests(unittest.TestCase):
    def test_agent_uses_semantic_policy_and_emits_agentlab_metadata(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()

        action, info = agent.get_action(
            {
                "goal": "Select priority as high",
                "pruned_html": '<select bid="priority-2" aria-label="Priority"></select>',
            }
        )

        self.assertEqual(action, 'select_option("priority-2", "high")')
        self.assertEqual(agent.action_set.subsets, ["bid", "nav", "infeas"])
        self.assertFalse(agent.action_set.multiaction)
        self.assertEqual(info["extra_info"]["phase"], "selected")
        self.assertEqual(info["stats"]["lhic_semantic_policy"], 1)

    def test_agent_advances_a_plan_without_blindly_repeating_actions(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()
        observation = {
            "goal": "Open settings page",
            "pruned_html": '<button bid="settings-1">Settings</button>',
        }

        first_action, _ = agent.get_action(observation)
        second_action, second_info = agent.get_action(
            {**observation, "last_action": first_action}
        )

        self.assertEqual(first_action, 'click("settings-1")')
        self.assertEqual(second_action, "noop()")
        self.assertTrue(second_info["extra_info"]["completed"])

    def test_agent_executes_one_action_per_turn_for_an_explicit_multi_step_plan(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()
        observation = {
            "goal": "Fill full name with Ada then select priority as high",
            "pruned_html": (
                '<input bid="name-7" aria-label="Full name">'
                '<select bid="priority-2" aria-label="Priority"></select>'
            ),
        }

        first_action, first_info = agent.get_action(observation)
        second_action, second_info = agent.get_action(
            {**observation, "last_action": first_action}
        )

        self.assertEqual(first_action, 'fill("name-7", "Ada")')
        self.assertEqual(second_action, 'select_option("priority-2", "high")')
        self.assertEqual(first_info["extra_info"]["stepIndex"], 0)
        self.assertTrue(second_info["extra_info"]["completed"])

    def test_agent_rebinds_an_idempotent_action_once_after_an_error(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()
        observation = {
            "goal": "Fill full name with Ada then select priority as high",
            "pruned_html": (
                '<input bid="name-7" aria-label="Full name">'
                '<select bid="priority-2" aria-label="Priority"></select>'
            ),
        }

        first_action, _ = agent.get_action(observation)
        recovered_action, recovered_info = agent.get_action(
            {
                **observation,
                "pruned_html": (
                    '<input bid="name-8" aria-label="Full name">'
                    '<select bid="priority-2" aria-label="Priority"></select>'
                ),
                "last_action_error": "Element was detached",
            }
        )
        blocked_action, blocked_info = agent.get_action(
            {**observation, "last_action_error": {"message": "still detached"}}
        )

        self.assertEqual(first_action, 'fill("name-7", "Ada")')
        self.assertEqual(recovered_action, 'fill("name-8", "Ada")')
        self.assertTrue(recovered_info["extra_info"]["recoveredFromActionError"])
        self.assertEqual(recovered_info["stats"]["recoveries"], 1)
        self.assertTrue(blocked_action.startswith("report_infeasible("))
        self.assertTrue(blocked_info["extra_info"]["blocked"])
        self.assertEqual(blocked_info["stats"]["action_error_blocked"], 1)

    def test_agent_does_not_treat_a_missing_action_error_as_a_failure(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()

        action, info = agent.get_action(
            {
                "goal": "Select priority as high",
                "pruned_html": '<select bid="priority-2" aria-label="Priority"></select>',
                "last_action_error": None,
            }
        )

        self.assertEqual(action, 'select_option("priority-2", "high")')
        self.assertNotIn("blocked", info["extra_info"])

    def test_agent_fails_closed_when_browsergym_does_not_echo_the_action_receipt(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()
        observation = {
            "goal": "Open settings page",
            "pruned_html": '<button bid="settings-1">Settings</button>',
        }

        first_action, _ = agent.get_action(observation)
        blocked_action, blocked_info = agent.get_action(observation)

        self.assertEqual(first_action, 'click("settings-1")')
        self.assertTrue(blocked_action.startswith("report_infeasible("))
        self.assertTrue(blocked_info["extra_info"]["blocked"])
        self.assertIn("execution receipt", blocked_info["think"])


    def test_agent_keeps_identical_goals_isolated_by_task_id(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()
        goal = "Open settings page"

        first_action, _ = agent.get_action(
            {
                "task_id": "task-1",
                "goal": goal,
                "pruned_html": '<button bid="settings-1">Settings</button>',
            }
        )
        second_action, _ = agent.get_action(
            {
                "task_id": "task-2",
                "goal": goal,
                "pruned_html": '<button bid="settings-2">Settings</button>',
            }
        )

        self.assertEqual(first_action, 'click("settings-1")')
        self.assertEqual(second_action, 'click("settings-2")')

    def test_agent_emits_explicit_http_navigation(self) -> None:
        agent_module = _load_agent_module()
        agent = agent_module.LhicSemanticAgent()

        action, info = agent.get_action(
            {
                "goal": "Navigate to https://example.test/docs.",
                "pruned_html": "",
            }
        )

        self.assertEqual(action, 'goto("https://example.test/docs")')
        self.assertEqual(info["extra_info"]["phase"], "navigated")

if __name__ == "__main__":
    unittest.main()
