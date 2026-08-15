from __future__ import annotations

import unittest

from runner_boundary import DispatchContext, StepResult, execute_with_lhic_boundary


class FakeEnv:
    def __init__(self, events, *, fail=False):
        self.events = events
        self.fail = fail

    def step(self, action, sleep_after_execution):
        self.events.append(("env.step", action, sleep_after_execution))
        if self.fail:
            raise RuntimeError("injected lost response")
        return {"screenshot": b"x"}, 0.0, False, {"ok": True}


class FakeBoundary:
    def __init__(self, events):
        self.events = events

    def before_dispatch(self, context: DispatchContext) -> None:
        self.events.append(("before_dispatch", context.action_id))

    def after_response(self, context: DispatchContext, result: StepResult) -> None:
        self.events.append(("after_response", context.action_id, result.done))

    def after_lost_response(self, context: DispatchContext, error: BaseException) -> None:
        self.events.append(("after_lost_response", context.action_id, type(error).__name__))


class RunnerBoundaryTest(unittest.TestCase):
    def test_persists_before_env_step_and_preserves_tuple(self):
        events = []
        result = execute_with_lhic_boundary(
            env=FakeEnv(events),
            boundary=FakeBoundary(events),
            task_id="task-1",
            action_index=7,
            action="pyautogui.click(10, 20)",
            sleep_after_execution=0.25,
        )

        self.assertEqual(events[0], ("before_dispatch", "osworld:task-1:7"))
        self.assertEqual(events[1][0], "env.step")
        self.assertEqual(events[2], ("after_response", "osworld:task-1:7", False))
        self.assertEqual(result[1:], (0.0, False, {"ok": True}))

    def test_lost_response_is_reported_without_synthetic_retry(self):
        events = []
        with self.assertRaisesRegex(RuntimeError, "injected lost response"):
            execute_with_lhic_boundary(
                env=FakeEnv(events, fail=True),
                boundary=FakeBoundary(events),
                task_id="task-2",
                action_index=3,
                action="pyautogui.press('enter')",
                sleep_after_execution=0.0,
            )

        self.assertEqual(events[0], ("before_dispatch", "osworld:task-2:3"))
        self.assertEqual(events[1][0], "env.step")
        self.assertEqual(events[2], ("after_lost_response", "osworld:task-2:3", "RuntimeError"))
        self.assertEqual(len(events), 3)


if __name__ == "__main__":
    unittest.main()
