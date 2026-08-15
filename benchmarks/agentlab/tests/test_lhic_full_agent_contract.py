import os
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class _FakeAgent:
    pass


class _FakeActionSet:
    def __init__(self, subsets, *, multiaction):
        self.subsets = subsets
        self.multiaction = multiaction


class _FakeAgentInfo(dict):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)


class _FakeAgentArgs:
    pass


def _load_full_agent_module():
    bgym = types.ModuleType("bgym")
    bgym.Agent = _FakeAgent
    bgym.HighLevelActionSet = _FakeActionSet
    bgym.AgentInfo = _FakeAgentInfo

    agentlab = types.ModuleType("agentlab")
    agents = types.ModuleType("agentlab.agents")
    agent_args = types.ModuleType("agentlab.agents.agent_args")
    agent_args.AgentArgs = _FakeAgentArgs
    agentlab.agents = agents
    agents.agent_args = agent_args

    module = types.ModuleType("lhic_full_agent_contract")
    module.__file__ = str(Path(__file__).parents[1] / "lhic_full_agent.py")
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


class _RecordingPlanner:
    def __init__(self, module):
        self.module = module
        self.observations = []

    def plan(self, observation):
        self.observations.append(observation)
        if len(self.observations) == 1:
            return self.module.PlannedAction(
                command='click("7")', name="click", reason="Open the visible result"
            )
        return self.module.PlannedAction(
            command='send_msg_to_user("done")',
            name="send_msg_to_user",
            reason="Return the answer",
        )


class LhicFullAgentContractTests(unittest.TestCase):
    def test_full_args_fail_closed_without_named_model_credential(self):
        module = _load_full_agent_module()
        args = module.LhicFullAgentArgs(model="provider/model", model_api_key_env="MISSING_KEY")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "MISSING_KEY"):
                args.validate()

    def test_full_agent_never_sends_credentials_to_remote_plaintext_http(self):
        module = _load_full_agent_module()
        args = module.LhicFullAgentArgs(
            model="provider/model",
            model_base_url="http://models.example.test/v1",
            model_api_key_env="MODEL_KEY",
        )
        with patch.dict(os.environ, {"MODEL_KEY": "secret"}, clear=True):
            with self.assertRaisesRegex(ValueError, "must use HTTPS"):
                args.validate()

        planner = module.OpenAICompatiblePlanner
        with self.assertRaisesRegex(ValueError, "must use HTTPS"):
            planner(
                model="provider/model",
                base_url="http://models.example.test/v1",
                api_key="secret",
                seed=0,
                temperature=0,
                timeout_seconds=1,
                max_attempts=1,
            )

    def test_model_response_body_is_bounded(self):
        module = _load_full_agent_module()

        class OversizedResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return None

            def read(self, amount):
                self.amount = amount
                return b"x" * amount

        response = OversizedResponse()
        planner = module.OpenAICompatiblePlanner(
            model="provider/model",
            base_url="https://models.example.test/v1",
            api_key="secret",
            seed=0,
            temperature=0,
            timeout_seconds=1,
            max_attempts=1,
        )
        with patch.object(module.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(module.PlannerError, "response exceeds"):
                planner._post({"model": "provider/model"})
        self.assertEqual(response.amount, module.MAX_MODEL_RESPONSE_BYTES + 1)

    def test_model_actions_require_exact_browsergym_schema(self):
        module = _load_full_agent_module()
        action = module._validate_model_action(
            '{"action":{"name":"scroll","args":{"delta_x":0,"delta_y":-500}},'
            '"reason":"Reveal more results"}'
        )
        self.assertEqual(action.command, "scroll(0, -500)")
        with self.assertRaisesRegex(module.PlannerError, "Unsupported action"):
            module._validate_model_action(
                '{"action":{"name":"python","args":{"code":"import os"}},'
                '"reason":"escape"}'
            )
        with self.assertRaisesRegex(module.PlannerError, "HTTP"):
            module._validate_model_action(
                '{"action":{"name":"goto","args":{"url":"javascript:alert(1)"}},'
                '"reason":"unsafe navigation"}'
            )

    def test_agent_records_exact_action_receipts_before_advancing(self):
        module = _load_full_agent_module()
        planner = _RecordingPlanner(module)
        agent = module.LhicFullAgent(
            model="provider/model",
            seed=19,
            enable_semantic_fast_path=False,
            planner=planner,
        )
        first_action, first_info = agent.get_action(
            {"task_id": "task-1", "goal": "Find the answer", "pruned_html": "[7] link"}
        )
        self.assertEqual(first_action, 'click("7")')
        self.assertEqual(first_info["extra_info"]["source"], "model-planner")
        self.assertTrue(first_info["extra_info"]["pendingReceiptId"])

        second_action, second_info = agent.get_action(
            {
                "task_id": "task-1",
                "goal": "Find the answer",
                "pruned_html": "answer",
                "last_action": first_action,
                "last_action_error": None,
            }
        )
        self.assertEqual(second_action, 'send_msg_to_user("done")')
        self.assertEqual(planner.observations[1]["latestReceipt"]["status"], "succeeded")
        self.assertEqual(second_info["extra_info"]["priorReceipt"]["actionSha256"],
                         planner.observations[1]["latestReceipt"]["actionSha256"])

    def test_agent_blocks_when_browsergym_does_not_echo_pending_action(self):
        module = _load_full_agent_module()
        planner = _RecordingPlanner(module)
        agent = module.LhicFullAgent(
            model="provider/model",
            enable_semantic_fast_path=False,
            planner=planner,
        )
        agent.get_action({"task_id": "t", "goal": "g"})
        action, info = agent.get_action(
            {"task_id": "t", "goal": "g", "last_action": 'click("other")'}
        )
        self.assertTrue(action.startswith("report_infeasible("))
        self.assertTrue(info["extra_info"]["blocked"])
        self.assertEqual(len(planner.observations), 1)


if __name__ == "__main__":
    unittest.main()
