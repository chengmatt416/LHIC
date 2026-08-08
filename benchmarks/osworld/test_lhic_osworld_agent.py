import sys
import time
import unittest

from lhic_osworld_agent import LHICOSWorldAgent


class BridgeTimeoutTests(unittest.TestCase):
    def test_partial_response_without_newline_times_out_and_terminates_bridge(self):
        script = (
            "import sys,time; "
            "sys.stdin.buffer.readline(); "
            "sys.stdout.buffer.write(b'{\\\"ok\\\":'); "
            "sys.stdout.buffer.flush(); "
            "time.sleep(10)"
        )
        agent = LHICOSWorldAgent(
            bridge_command=[sys.executable, "-c", script],
            bridge_config="ignored.json",
            benchmark_revision="test-revision",
            seed=1,
            bridge_timeout_seconds=0.05,
        )

        started = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, "timed out after 0.05 seconds"):
            agent._request({"type": "test"})

        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNotNone(agent._process)
        self.assertIsNotNone(agent._process.poll())


if __name__ == "__main__":
    unittest.main()
