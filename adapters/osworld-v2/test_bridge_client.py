from __future__ import annotations

import pathlib
import tempfile
import unittest

from bridge_client import NodeBoundaryClient
from runner_boundary import DispatchContext, execute_with_lhic_boundary


class FakeEnv:
    def __init__(self, *, fail=False):
        self.fail = fail
        self.calls = 0

    def step(self, action, sleep_after_execution):
        self.calls += 1
        if self.fail:
            raise RuntimeError("transport lost after dispatch")
        return {"screenshot": b"fixture"}, 0.0, False, {"action": action}


class NodeBoundaryClientTest(unittest.TestCase):
    def test_real_typescript_bridge_persists_before_env_step_and_records_executed(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = pathlib.Path(directory) / "ledger.json"
            env = FakeEnv()
            with NodeBoundaryClient(ledger_path=ledger) as boundary:
                execute_with_lhic_boundary(
                    env=env,
                    boundary=boundary,
                    task_id="bridge-task",
                    action_index=1,
                    action="pyautogui.click(10, 20)",
                    sleep_after_execution=0.0,
                )
                state = boundary.state("osworld:bridge-task:1")

            self.assertEqual(env.calls, 1)
            self.assertEqual(state["state"], "executed")
            self.assertTrue(ledger.exists())

    def test_lost_response_survives_bridge_restart_and_can_recover_to_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = pathlib.Path(directory) / "ledger.json"
            context = DispatchContext(
                task_id="restart-task",
                action_id="unused-by-client",
                action_index=4,
                action="pyautogui.press('enter')",
            )

            first = NodeBoundaryClient(ledger_path=ledger)
            first.before_dispatch(context)
            self.assertEqual(first.state("osworld:restart-task:4")["state"], "possibly_committed")
            first.close()

            evidence = {
                "evidenceId": "osworld-contract-evidence",
                "verifier": "external",
                "condition": "test postcondition",
                "result": "passed",
                "artifactHashes": ["c" * 64],
                "createdAt": "2026-08-15T00:00:00.000Z",
            }
            with NodeBoundaryClient(ledger_path=ledger) as restarted:
                self.assertEqual(
                    restarted.state("osworld:restart-task:4")["state"],
                    "possibly_committed",
                )
                result = restarted.recover(
                    action_id="osworld:restart-task:4",
                    observation="effect_present",
                    evidence=evidence,
                )
                self.assertEqual(result["state"], "verified")
                self.assertFalse(result["dispatchAllowed"])

    def test_failed_env_step_is_not_retried_by_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = pathlib.Path(directory) / "ledger.json"
            env = FakeEnv(fail=True)
            with NodeBoundaryClient(ledger_path=ledger) as boundary:
                with self.assertRaisesRegex(RuntimeError, "transport lost"):
                    execute_with_lhic_boundary(
                        env=env,
                        boundary=boundary,
                        task_id="lost-task",
                        action_index=2,
                        action="pyautogui.write('x')",
                        sleep_after_execution=0.0,
                    )
                state = boundary.state("osworld:lost-task:2")

            self.assertEqual(env.calls, 1)
            self.assertEqual(state["state"], "possibly_committed")


if __name__ == "__main__":
    unittest.main()
