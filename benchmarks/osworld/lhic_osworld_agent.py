"""OSWorld 2.0 agent adapter for the LHIC episode bridge.

The official OSWorld harness owns DesktopEnv construction, reset, step, and
assessment. This adapter only converts observations and returns computer_13
actions proposed by the configured LHIC TaskSource.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import select
import subprocess
import sys
import time
from typing import Any, Mapping, Optional, Sequence
from uuid import uuid4


PROTOCOL_VERSION = "lhic-osworld-bridge-v1"
MAX_RESPONSE_BYTES = 2_000_000
DEFAULT_BRIDGE_TIMEOUT_SECONDS = 75.0


class LHICOSWorldAgent:
    """Drop-in OSWorld 2.0 agent with a strict, persistent JSONL bridge."""

    def __init__(
        self,
        *,
        bridge_command: Optional[Sequence[str]] = None,
        bridge_config: Optional[str] = None,
        benchmark_revision: Optional[str] = None,
        seed: Optional[int] = None,
        harness_config: Optional[Mapping[str, Any]] = None,
        observation_type: str = "screenshot_a11y_tree",
        bridge_timeout_seconds: Optional[float] = None,
        action_space: str = "computer_13",
        **_: Any,
    ) -> None:
        if action_space != "computer_13":
            raise ValueError("LHIC OSWorld adapter requires action_space='computer_13'.")
        if observation_type not in {"a11y_tree", "screenshot_a11y_tree"}:
            raise ValueError(
                "LHIC OSWorld adapter requires a11y_tree or screenshot_a11y_tree observations."
            )
        self.action_space = action_space
        self.observation_type = observation_type
        self.benchmark_revision = benchmark_revision or os.environ.get(
            "LHIC_OSWORLD_BENCHMARK_REVISION"
        )
        if not self.benchmark_revision:
            raise ValueError("LHIC_OSWORLD_BENCHMARK_REVISION is required.")
        configured_seed = seed
        if configured_seed is None:
            raw_seed = os.environ.get("LHIC_OSWORLD_SEED")
            if raw_seed is None:
                raise ValueError("LHIC_OSWORLD_SEED is required.")
            try:
                configured_seed = int(raw_seed)
            except ValueError as error:
                raise ValueError("LHIC_OSWORLD_SEED must be an integer.") from error
        if configured_seed < 0:
            raise ValueError("OSWorld seed must be non-negative.")
        self.seed = configured_seed
        self.harness_config = dict(harness_config or {})
        self._command = self._resolve_command(bridge_command, bridge_config)
        configured_timeout = bridge_timeout_seconds
        if configured_timeout is None:
            raw_timeout = os.environ.get("LHIC_OSWORLD_BRIDGE_TIMEOUT_SECONDS")
            if raw_timeout is not None:
                try:
                    configured_timeout = float(raw_timeout)
                except ValueError as error:
                    raise ValueError(
                        "LHIC_OSWORLD_BRIDGE_TIMEOUT_SECONDS must be numeric."
                    ) from error
        self.bridge_timeout_seconds = (
            DEFAULT_BRIDGE_TIMEOUT_SECONDS
            if configured_timeout is None
            else configured_timeout
        )
        if (
            not isinstance(self.bridge_timeout_seconds, (int, float))
            or not 0 < self.bridge_timeout_seconds <= 3_600
        ):
            raise ValueError(
                "OSWorld bridge timeout must be between 0 and 3600 seconds."
            )
        self._process: Optional[subprocess.Popen[bytes]] = None
        self._episode_id: Optional[str] = None
        self._instruction: Optional[str] = None
        self._previous_receipt: Optional[dict[str, Any]] = None
        self._stdout_buffer = bytearray()
        self._logger: Any = None

    def reset(self, logger: Any = None) -> None:
        """Close only the protocol episode boundary; never reset or create a VM."""
        self._logger = logger
        if self._episode_id is not None:
            self._request(
                {
                    "type": "end_episode",
                    "protocolVersion": PROTOCOL_VERSION,
                    "episodeId": self._episode_id,
                    "terminal": "harness_reset",
                }
            )
        self._episode_id = None
        self._instruction = None
        self._previous_receipt = None

    def predict(self, instruction: str, obs: Mapping[str, Any]) -> tuple[str, list[Any]]:
        """Convert one official observation and request one next action."""
        if not instruction.strip():
            raise ValueError("OSWorld instruction is empty.")
        if self._episode_id is None:
            self._episode_id = uuid4().hex
            self._instruction = instruction
            self._request(
                {
                    "type": "start_episode",
                    "protocolVersion": PROTOCOL_VERSION,
                    "episodeId": self._episode_id,
                    "instruction": instruction,
                    "seed": self.seed,
                    "benchmarkRevision": self.benchmark_revision,
                    "harnessConfig": self.harness_config,
                }
            )
        elif instruction != self._instruction:
            raise RuntimeError("Instruction changed inside an active OSWorld episode.")

        observation = self._convert_observation(obs)
        response = self._request(
            {
                "type": "step",
                "protocolVersion": PROTOCOL_VERSION,
                "episodeId": self._episode_id,
                "observation": observation,
                **(
                    {"previousReceipt": self._previous_receipt}
                    if self._previous_receipt is not None
                    else {}
                ),
            }
        )
        receipt = response.get("receipt")
        if not isinstance(receipt, dict) or not isinstance(receipt.get("receiptId"), str):
            raise RuntimeError("LHIC bridge omitted the step receipt.")
        self._previous_receipt = {
            "receiptId": receipt["receiptId"],
            # A subsequent predict means official env.step returned an observation.
            # It does not imply evaluator success or task completion.
            "status": "dispatched",
        }
        action = response.get("osworldAction")
        if isinstance(action, str):
            if action not in {"WAIT", "DONE", "FAIL"}:
                raise RuntimeError("LHIC bridge returned an unknown terminal action.")
        elif not isinstance(action, dict):
            raise RuntimeError("LHIC bridge returned an invalid computer_13 action.")
        trace = json.dumps(
            {
                "protocolVersion": PROTOCOL_VERSION,
                "episodeId": self._episode_id,
                "step": response.get("step"),
                "receiptId": receipt["receiptId"],
                "decision": response.get("decision"),
            },
            ensure_ascii=False,
        )
        return trace, [action]

    def close(
        self,
        terminal: str = "harness_reset",
        error: Optional[str] = None,
    ) -> None:
        """End the bridge episode and require a clean child-process exit."""
        if terminal not in {"done", "fail", "error", "max_steps", "harness_reset"}:
            raise ValueError("Unknown OSWorld terminal state.")
        request_error: Optional[BaseException] = None
        if self._episode_id is not None:
            try:
                self._request(
                    {
                        "type": "end_episode",
                        "protocolVersion": PROTOCOL_VERSION,
                        "episodeId": self._episode_id,
                        "terminal": terminal,
                        **({"error": error} if error else {}),
                    }
                )
            except BaseException as caught:
                request_error = caught
        self._episode_id = None
        self._instruction = None
        self._previous_receipt = None
        if self._process is not None:
            process = self._process
            self._process = None
            if process.stdin is not None:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
            try:
                return_code = process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._terminate_process(process)
                return_code = process.returncode
                if request_error is None:
                    request_error = RuntimeError(
                        "LHIC bridge did not exit within 10 seconds after stdin closed."
                    )
            if return_code != 0 and request_error is None:
                request_error = RuntimeError(
                    f"LHIC bridge exited with non-zero status {return_code}."
                )
        if request_error is not None:
            raise request_error

    def _request(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        process = self._ensure_process()
        if process.stdin is None or process.stdout is None:
            raise RuntimeError("LHIC bridge pipes are unavailable.")
        serialized = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        try:
            process.stdin.write(serialized.encode("utf-8") + b"\n")
            process.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise RuntimeError("LHIC bridge closed while receiving a request.") from error
        response_line = self._read_response_line(process)
        try:
            response = json.loads(response_line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("LHIC bridge returned invalid JSON.") from error
        if not isinstance(response, dict):
            raise RuntimeError("LHIC bridge response must be an object.")
        if response.get("protocolVersion") != PROTOCOL_VERSION:
            raise RuntimeError("LHIC bridge protocol version mismatch.")
        if response.get("ok") is not True:
            detail = response.get("error")
            raise RuntimeError(
                detail if isinstance(detail, str) else "LHIC bridge request failed."
            )
        return response

    def _read_response_line(self, process: subprocess.Popen[bytes]) -> bytes:
        if process.stdout is None:
            raise RuntimeError("LHIC bridge stdout is unavailable.")
        deadline = time.monotonic() + float(self.bridge_timeout_seconds)
        while True:
            newline = self._stdout_buffer.find(b"\n")
            if newline >= 0:
                line = bytes(self._stdout_buffer[:newline])
                del self._stdout_buffer[: newline + 1]
                return line
            if len(self._stdout_buffer) > MAX_RESPONSE_BYTES:
                self._terminate_process(process)
                raise RuntimeError("LHIC bridge response is oversized.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                self._terminate_process(process)
                raise RuntimeError(
                    f"LHIC bridge response timed out after "
                    f"{self.bridge_timeout_seconds:g} seconds."
                )
            readable, _, _ = select.select([process.stdout], [], [], remaining)
            if not readable:
                continue
            chunk = os.read(
                process.stdout.fileno(),
                min(65_536, MAX_RESPONSE_BYTES + 1 - len(self._stdout_buffer)),
            )
            if not chunk:
                return_code = process.poll()
                raise RuntimeError(
                    "LHIC bridge closed without a response"
                    + (f" (exit {return_code})." if return_code is not None else ".")
                )
            self._stdout_buffer.extend(chunk)

    @staticmethod
    def _terminate_process(process: subprocess.Popen[bytes]) -> None:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        if process.stdin is not None:
            process.stdin.close()
        if process.stdout is not None:
            process.stdout.close()

    def _ensure_process(self) -> subprocess.Popen[bytes]:
        if self._process is not None:
            if self._process.poll() is not None:
                raise RuntimeError(
                    f"LHIC bridge is no longer running (exit {self._process.returncode})."
                )
            return self._process
        self._process = subprocess.Popen(
            self._command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=None,
            bufsize=0,
        )
        return self._process

    @staticmethod
    def _convert_observation(obs: Mapping[str, Any]) -> dict[str, Any]:
        tree = obs.get("accessibility_tree")
        if not isinstance(tree, str) or not tree.strip():
            raise ValueError(
                "OSWorld observation lacks a non-empty accessibility_tree; "
                "screenshot-only evaluation is unsupported."
            )
        converted: dict[str, Any] = {"accessibilityTree": tree}
        screenshot = obs.get("screenshot")
        if screenshot is not None:
            if isinstance(screenshot, str):
                if screenshot.startswith("data:") and "," in screenshot:
                    try:
                        screenshot_bytes = base64.b64decode(
                            screenshot.split(",", 1)[1], validate=True
                        )
                    except ValueError as error:
                        raise ValueError("OSWorld screenshot data URL is invalid.") from error
                else:
                    screenshot_bytes = screenshot.encode("utf-8")
            elif isinstance(screenshot, (bytes, bytearray, memoryview)):
                screenshot_bytes = bytes(screenshot)
            else:
                raise ValueError("OSWorld screenshot has an unsupported representation.")
            converted["screenshotSha256"] = hashlib.sha256(screenshot_bytes).hexdigest()
            converted["screenshotBytes"] = len(screenshot_bytes)
        for source_key, target_key in (
            ("screen_width", "screenWidth"),
            ("screen_height", "screenHeight"),
        ):
            dimension = obs.get(source_key)
            if isinstance(dimension, int) and dimension > 0:
                converted[target_key] = dimension
        return converted

    @staticmethod
    def _resolve_command(
        bridge_command: Optional[Sequence[str]], bridge_config: Optional[str]
    ) -> list[str]:
        command = list(bridge_command or [])
        if not command:
            raw = os.environ.get("LHIC_OSWORLD_BRIDGE_COMMAND_JSON")
            if not raw:
                raise ValueError("LHIC_OSWORLD_BRIDGE_COMMAND_JSON is required.")
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as error:
                raise ValueError(
                    "LHIC_OSWORLD_BRIDGE_COMMAND_JSON must be a JSON array."
                ) from error
            if not isinstance(parsed, list) or not all(
                isinstance(item, str) and item for item in parsed
            ):
                raise ValueError(
                    "LHIC_OSWORLD_BRIDGE_COMMAND_JSON must contain command arguments."
                )
            command = parsed
        config = bridge_config or os.environ.get("LHIC_OSWORLD_BRIDGE_CONFIG")
        if not config:
            raise ValueError("LHIC_OSWORLD_BRIDGE_CONFIG is required.")
        return [*command, "--config", os.path.abspath(config)]

    def __enter__(self) -> "LHICOSWorldAgent":
        self._ensure_process()
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> None:
        self.close(terminal="error" if exc is not None else "harness_reset", error=str(exc) if exc else None)

    def __del__(self) -> None:
        process = self._process
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()


def preflight() -> int:
    """Validate Python-side configuration and execute the Node preflight."""
    agent = LHICOSWorldAgent()
    command = [*agent._command, "--preflight"]
    result = subprocess.run(command, check=False, text=True, capture_output=True)
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    return result.returncode


if __name__ == "__main__":
    if sys.argv[1:] != ["--preflight"]:
        raise SystemExit("Usage: python lhic_osworld_agent.py --preflight")
    raise SystemExit(preflight())
