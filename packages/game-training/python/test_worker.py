import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import worker


class FakeKey:
    def __init__(self, char: str | None = None, name: str | None = None) -> None:
        self.char = char
        self.name = name


class WorkerCoreSmokeTest(unittest.TestCase):
    def test_2d_and_3d_model_shapes_are_incompatible(self) -> None:
        self.assertEqual(worker.model_spec("2d"), (2, 128, 128, 2))
        self.assertEqual(worker.model_spec("3d"), (4, 96, 96, 4))
        self.assertEqual(worker.MIN_TRAINING_SAMPLES, 16)

    def test_action_labels_cover_legal_diagonal_movement(self) -> None:
        self.assertEqual(worker.movement_label(["KeyW", "KeyA"]), 5)
        self.assertEqual(worker.movement_label(["KeyW", "KeyS"]), 0)
        self.assertEqual(worker.aim_label(0.5), 4)

    def test_training_uses_a_chronological_holdout_split(self) -> None:
        self.assertEqual(worker.training_split_counts(16, 0.2), (13, 3))
        with self.assertRaises(ValueError):
            worker.training_split_counts(16, 0.05)

    def test_desktop_region_rejects_unbounded_coordinates(self) -> None:
        with self.assertRaises(ValueError):
            worker.desktop_region(
                {"captureRegion": {"x": -1, "y": 0, "width": 10, "height": 10}}
            )

    def test_desktop_key_allowlist_rejects_an_unapproved_key(self) -> None:
        with self.assertRaises(ValueError):
            worker.allowed_desktop_keys(
                {
                    "allowedKeys": ["KeyW"],
                    "activeKeys": [],
                    "desiredKeys": ["KeyA"],
                }
            )

    def test_desktop_primary_pulse_requires_approval_and_cannot_be_held(self) -> None:
        with self.assertRaises(ValueError):
            worker.desktop_primary_state({"primaryClick": True})
        with self.assertRaises(ValueError):
            worker.desktop_primary_state(
                {
                    "allowPrimaryClick": True,
                    "desiredPrimaryDown": True,
                    "primaryClick": True,
                }
            )
        self.assertEqual(
            worker.desktop_primary_state(
                {"allowPrimaryClick": True, "primaryClick": True}
            ),
            (False, False, True),
        )

    def test_desktop_recorder_maps_allowed_keyboard_events(self) -> None:
        self.assertEqual(worker.desktop_key_code(FakeKey(char="W")), "KeyW")
        self.assertEqual(worker.desktop_key_code(FakeKey(name="space")), "Space")
        self.assertIsNone(worker.desktop_key_code(FakeKey(char="q")))


if __name__ == "__main__":
    unittest.main()
