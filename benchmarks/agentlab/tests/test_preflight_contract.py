import contextlib
import io
import json
import sys
import types
import unittest
from unittest.mock import patch

import preflight


class _FakeBrowser:
    def close(self) -> None:
        return None


class _FakePlaywright:
    class Chromium:
        @staticmethod
        def launch(*, headless: bool) -> _FakeBrowser:
            if not headless:
                raise AssertionError("preflight must keep Chromium headless")
            return _FakeBrowser()

    chromium = Chromium()


class _FakePlaywrightContext:
    def __enter__(self) -> _FakePlaywright:
        return _FakePlaywright()

    def __exit__(self, *_: object) -> None:
        return None


class PreflightContractTests(unittest.TestCase):
    def test_preflight_creates_a_workarena_study_without_inspecting_secrets(self) -> None:
        calls: dict[str, object] = {}

        class FakeAgentArgs:
            agent_name = "LhicSemanticBidAgent"


        class FakeFullAgentArgs:
            agent_name = "LhicFullModelAgent"

            def __init__(self, *, model: str) -> None:
                self.model = model
        def make_study(**kwargs: object) -> object:
            calls.update(kwargs)
            return types.SimpleNamespace(exp_args_list=[object(), object()])

        agentlab = types.ModuleType("agentlab")
        experiments = types.ModuleType("agentlab.experiments")
        study = types.ModuleType("agentlab.experiments.study")
        study.make_study = make_study
        agentlab.experiments = experiments
        experiments.study = study

        browsergym = types.ModuleType("browsergym")
        browsergym_webarena = types.ModuleType("browsergym.webarena")
        browsergym.webarena = browsergym_webarena
        lhic_agent = types.ModuleType("lhic_agent")
        lhic_agent.LhicSemanticAgentArgs = FakeAgentArgs
        lhic_full_agent = types.ModuleType("lhic_full_agent")
        lhic_full_agent.LhicFullAgentArgs = FakeFullAgentArgs
        playwright = types.ModuleType("playwright")
        sync_api = types.ModuleType("playwright.sync_api")
        sync_api.sync_playwright = _FakePlaywrightContext
        playwright.sync_api = sync_api

        with (
            patch.dict(
                sys.modules,
                {
                    "agentlab": agentlab,
                    "agentlab.experiments": experiments,
                    "agentlab.experiments.study": study,
                    "browsergym": browsergym,
                    "browsergym.webarena": browsergym_webarena,
                    "lhic_agent": lhic_agent,
                    "lhic_full_agent": lhic_full_agent,
                    "playwright": playwright,
                    "playwright.sync_api": sync_api,
                },
            ),
            patch.object(preflight, "version", side_effect=lambda name: f"{name}-version"),
            contextlib.redirect_stdout(io.StringIO()) as output,
        ):
            preflight.main()

        report = json.loads(output.getvalue())
        self.assertEqual(calls["benchmark"], "workarena_l1")
        self.assertEqual(calls["agent_args"][0].agent_name, "LhicSemanticBidAgent")
        self.assertEqual(report["lhicFullAgentAdapter"], "LhicFullModelAgent")
        self.assertEqual(report["browsergymWebarena"], "browsergym-webarena-version")
        self.assertEqual(report["workarenaL1StudyTaskCount"], 2)
        self.assertRegex(report["pythonPackagesSha256"], r"^[0-9a-f]{64}$")
        self.assertFalse(report["secretValuesInspected"])


if __name__ == "__main__":
    unittest.main()
