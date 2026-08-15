"""Persistent Python client for the LHIC-Core TypeScript execution boundary."""

from __future__ import annotations

import json
import pathlib
import subprocess
import uuid
from typing import Any

from runner_boundary import DispatchContext, StepResult


class BridgeError(RuntimeError):
    pass


class DispatchBlocked(BridgeError):
    pass


class NodeBoundaryClient:
    """BoundaryClient implementation backed by the TypeScript research kernel.

    The Node subprocess is persistent so durable boundary operations do not pay
    process startup cost on every OSWorld action. Durable state itself lives in
    the supplied ledger file and survives bridge-process restart.
    """

    def __init__(
        self,
        *,
        ledger_path: str | pathlib.Path,
        bridge_server: str | pathlib.Path | None = None,
        node_binary: str = "node",
    ) -> None:
        here = pathlib.Path(__file__).resolve().parent
        self.bridge_server = pathlib.Path(bridge_server or here / "bridge_server.ts").resolve()
        self.ledger_path = pathlib.Path(ledger_path).resolve()
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        self.process = subprocess.Popen(
            [
                node_binary,
                "--experimental-strip-types",
                str(self.bridge_server),
                str(self.ledger_path),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

    def _request(self, op: str, **payload: Any) -> Any:
        if self.process.poll() is not None:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise BridgeError(f"LHIC bridge exited unexpectedly: {stderr}")
        if self.process.stdin is None or self.process.stdout is None:
            raise BridgeError("LHIC bridge stdio is unavailable")

        request_id = uuid.uuid4().hex
        request = {"id": request_id, "op": op, **payload}
        self.process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read() if self.process.stderr else ""
            raise BridgeError(f"LHIC bridge returned EOF: {stderr}")
        response = json.loads(line)
        if response.get("id") != request_id:
            raise BridgeError("LHIC bridge response correlation mismatch")
        if not response.get("ok"):
            raise BridgeError(str(response.get("error", "unknown bridge error")))
        return response.get("result")

    @staticmethod
    def action_id(context: DispatchContext) -> str:
        return f"osworld:{context.task_id}:{context.action_index}"

    def before_dispatch(self, context: DispatchContext) -> None:
        result = self._request(
            "before_dispatch",
            taskId=context.task_id,
            actionIndex=context.action_index,
            action=context.action,
        )
        if not result.get("dispatchAllowed"):
            raise DispatchBlocked(result.get("reason", "LHIC blocked dispatch"))
        if result.get("state") != "possibly_committed":
            raise BridgeError(f"Unexpected prepared state: {result}")

    def after_response(self, context: DispatchContext, result: StepResult) -> None:
        boundary_result = self._request(
            "after_response",
            actionId=self.action_id(context),
        )
        if boundary_result.get("state") not in {"executed", "verified"}:
            raise BridgeError(f"Unexpected response state: {boundary_result}")

    def after_lost_response(self, context: DispatchContext, error: BaseException) -> None:
        boundary_result = self._request(
            "after_lost_response",
            actionId=self.action_id(context),
        )
        if boundary_result.get("state") != "possibly_committed":
            raise BridgeError(f"Lost response did not preserve ambiguity: {boundary_result}")

    def recover(self, *, action_id: str, observation: str, evidence: dict[str, Any] | None = None) -> Any:
        payload: dict[str, Any] = {
            "actionId": action_id,
            "observation": observation,
        }
        if evidence is not None:
            payload["evidence"] = evidence
        return self._request("recover", **payload)

    def state(self, action_id: str) -> Any:
        return self._request("state", actionId=action_id)

    def close(self) -> None:
        if self.process.poll() is None:
            if self.process.stdin:
                self.process.stdin.close()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)

    def __enter__(self) -> "NodeBoundaryClient":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()
