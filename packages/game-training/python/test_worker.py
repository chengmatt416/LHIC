import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import worker


class WorkerCoreSmokeTest(unittest.TestCase):
    def test_2d_and_3d_model_shapes_are_incompatible(self) -> None:
        self.assertEqual(worker.model_spec("2d"), (2, 128, 128, 2))
        self.assertEqual(worker.model_spec("3d"), (4, 96, 96, 4))

    def test_action_labels_cover_legal_diagonal_movement(self) -> None:
        self.assertEqual(worker.movement_label(["KeyW", "KeyA"]), 5)
        self.assertEqual(worker.movement_label(["KeyW", "KeyS"]), 0)
        self.assertEqual(worker.aim_label(0.5), 4)

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


if __name__ == "__main__":
    unittest.main()
