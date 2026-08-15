import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from run_study import STUDY_COMMENT, StudyConfig, parse_args, run_study


class _FakeResultFrame:
    def __init__(self, records: list[dict[str, object]]) -> None:
        self.records = records

    def to_dict(self, *, orient: str) -> list[dict[str, object]]:
        if orient != "records":
            raise AssertionError(f"unexpected orientation: {orient}")
        return self.records


class _FakeStudy:
    def __init__(
        self,
        directory: Path,
        records: list[dict[str, object]] | None = None,
        expected_experiments: int = 1,
    ) -> None:
        self.dir = directory
        self.exp_args_list = [object()] * expected_experiments
        self.records = (
            [{"cum_reward": 1.0, "err_msg": None}]
            if records is None
            else records
        )
        self.override_max_steps_value: int | None = None
        self.run_arguments: dict[str, object] | None = None

    def override_max_steps(self, max_steps: int) -> None:
        self.override_max_steps_value = max_steps

    def run(self, **kwargs: object) -> None:
        self.run_arguments = kwargs
        self.dir.mkdir(parents=True, exist_ok=True)
        (self.dir / "result.csv").write_text("reward\n1\n", encoding="utf-8")

    def get_results(
        self, *, also_save: bool
    ) -> tuple[_FakeResultFrame, object, str]:
        if not also_save:
            raise AssertionError("result artifacts must be saved")
        return _FakeResultFrame(self.records), object(), ""


class RunStudyTests(unittest.TestCase):
    def test_parser_requires_full_benchmark_and_rejects_nonpositive_jobs(self) -> None:
        config = parse_args(["--benchmark", "workarena_l1"])

        self.assertEqual(config.benchmark, "workarena_l1")
        self.assertEqual(config.seed, 0)
        self.assertEqual(config.jobs, 1)
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parse_args(["--benchmark", "workarena_l1", "--jobs", "0"])

    def test_runner_writes_a_file_hashed_manifest_without_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output_dir = Path(directory)
            study = _FakeStudy(output_dir / "agent-study")
            calls: dict[str, object] = {}

            def make_study(**kwargs: object) -> _FakeStudy:
                calls.update(kwargs)
                return study

            with (
                patch.dict(
                    "os.environ",
                    {
                        "LHIC_SOURCE_REVISION": "0123456789abcdef",
                        "LHIC_IMAGE_DIGEST": "sha256:" + "1" * 64,
                    },
                    clear=True,
                ),
                patch(
                    "run_study.collect_installed_python_packages",
                    return_value=["agentlab==0.4.0", "browsergym==0.14.3"],
                ),
            ):
                manifest_path = run_study(
                    StudyConfig(
                        benchmark="workarena_l1",
                        seed=7,
                        jobs=1,
                        backend="sequential",
                        relaunches=1,
                        strict_reproducibility=True,
                        output_dir=output_dir,
                        max_steps=None,
                    ),
                    make_study,
                    agent_args="agent",
                )

            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(calls["benchmark"], "workarena_l1")
            self.assertEqual(calls["agent_args"], ["agent"])
            self.assertEqual(calls["comment"], STUDY_COMMENT)
            self.assertIsNone(study.override_max_steps_value)
            self.assertEqual(study.run_arguments["n_jobs"], 1)
            self.assertEqual(manifest["config"]["benchmark"], "workarena_l1")
            self.assertEqual(manifest["config"]["seed"], 7)
            self.assertEqual(
                manifest["outcome"],
                {
                    "expectedExperiments": 1,
                    "completedExperiments": 1,
                    "erroredExperiments": 0,
                },
            )
            self.assertEqual(manifest["files"][0]["path"], "result.csv")
            self.assertEqual(
                manifest["runtime"]["imageDigest"], "sha256:" + "1" * 64
            )
            self.assertEqual(
                manifest["runtime"]["pythonPackages"],
                ["agentlab==0.4.0", "browsergym==0.14.3"],
            )
            self.assertRegex(manifest["runtime"]["pythonPackagesSha256"], r"^[0-9a-f]{64}$")
            self.assertTrue(manifest["secretValuesRecorded"] is False)

    def test_strict_run_rejects_a_debug_step_limit_or_missing_source_revision(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            config = StudyConfig(
                seed=0,
                benchmark="workarena_l1",
                jobs=1,
                backend="sequential",
                relaunches=1,
                strict_reproducibility=True,
                output_dir=Path(directory),
                max_steps=10,
            )

            with self.assertRaisesRegex(ValueError, "max-steps"):
                run_study(config, lambda **_: _FakeStudy(Path(directory)), "agent")

            without_limit = StudyConfig(
                benchmark=config.benchmark,
                seed=config.seed,
                jobs=config.jobs,
                backend=config.backend,
                relaunches=config.relaunches,
                strict_reproducibility=config.strict_reproducibility,
                output_dir=config.output_dir,
                max_steps=None,
            )
            with patch.dict(
                "os.environ", {"LHIC_SOURCE_REVISION": "unknown"}, clear=True
            ):
                with self.assertRaisesRegex(ValueError, "LHIC_SOURCE_REVISION"):
                    run_study(
                        without_limit,
                        lambda **_: _FakeStudy(Path(directory)),
                        "agent",
                    )

            with patch.dict(
                "os.environ",
                {"LHIC_SOURCE_REVISION": "0123456789abcdef"},
                clear=True,
            ):
                with self.assertRaisesRegex(ValueError, "LHIC_IMAGE_DIGEST"):
                    run_study(
                        without_limit,
                        lambda **_: _FakeStudy(Path(directory)),
                        "agent",
                    )

    def test_runner_rejects_incomplete_or_errored_studies_without_a_manifest(self) -> None:
        cases = [
            (
                _FakeStudy(
                    Path("unused"),
                    records=[],
                    expected_experiments=1,
                ),
                "incomplete",
            ),
            (
                _FakeStudy(
                    Path("unused"),
                    records=[{"cum_reward": 0.0, "err_msg": "browser crashed"}],
                ),
                "errored",
            ),
            (
                _FakeStudy(
                    Path("unused"),
                    records=[{"cum_reward": None, "err_msg": None}],
                ),
                "missing-reward",
            ),
        ]
        for study_template, expected_message in cases:
            with self.subTest(expected_message):
                with tempfile.TemporaryDirectory() as directory:
                    study = _FakeStudy(
                        Path(directory) / "agent-study",
                        records=study_template.records,
                        expected_experiments=len(study_template.exp_args_list),
                    )

                    with self.assertRaisesRegex(RuntimeError, expected_message):
                        run_study(
                            StudyConfig(
                                benchmark="workarena_l1",
                                seed=0,
                                jobs=1,
                                backend="sequential",
                                relaunches=1,
                                strict_reproducibility=False,
                                output_dir=Path(directory),
                                max_steps=None,
                            ),
                            lambda **_: study,
                            "agent",
                        )

                    self.assertFalse(
                        (study.dir / "lhic-study-manifest.json").exists()
                    )


if __name__ == "__main__":
    unittest.main()
