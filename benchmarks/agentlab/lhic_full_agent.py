"""General model-backed AgentLab agent with a deterministic semantic fast path.

The model may choose only one BrowserGym high-level action from a strict JSON
schema per turn.  Model output is data, never executable Python.  Every issued
action remains pending until BrowserGym echoes it, producing a receipt that is
included in AgentLab's action trace.  The OpenAI-compatible HTTP transport is
endpoint-neutral and reads its credential only from the configured environment
variable.
"""

from __future__ import annotations

import hashlib
import json
import ipaddress
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import bgym
from agentlab.agents.agent_args import AgentArgs

from lhic_semantic_policy import PlanState, propose_plan_action


DEFAULT_BASE_URL = "https://api.openai.com/v1"
MAX_MODEL_RESPONSE_BYTES = 2_000_000
_ALLOWED_ACTIONS = {
    "click",
    "fill",
    "select_option",
    "hover",
    "press",
    "drag_and_drop",
    "scroll",
    "goto",
    "go_back",
    "go_forward",
    "new_tab",
    "tab_close",
    "tab_focus",
    "send_msg_to_user",
    "report_infeasible",
}
_ACTION_SPEC = """Return exactly one JSON object:
{"action":{"name":"ACTION_NAME","args":{...}},"reason":"brief reason"}
Allowed actions and exact arguments:
click {"bid": string}
fill {"bid": string, "value": string}
select_option {"bid": string, "options": string or array of strings}
hover {"bid": string}
press {"bid": string, "key_comb": string}
drag_and_drop {"from_bid": string, "to_bid": string}
scroll {"delta_x": number, "delta_y": number}
goto {"url": http-or-https URL}
go_back {}, go_forward {}, new_tab {}, tab_close {}
tab_focus {"index": non-negative integer}
send_msg_to_user {"text": string}
report_infeasible {"reason": string}
Do not emit Python, markdown, selectors, coordinates, or multiple actions.
Use only BIDs visible in the supplied observation. Do not claim an action
succeeded: the harness supplies execution receipts on the next turn."""


class PlannerError(RuntimeError):
    """A model request or schema validation failed closed."""


@dataclass(frozen=True)
class PlannedAction:
    command: str
    name: str
    reason: str


@dataclass(frozen=True)
class _PendingAction:
    command: str
    source: str
    receipt_id: str
    semantic_next_state: PlanState | None


@dataclass
class LhicFullAgentArgs(AgentArgs):
    """Serializable AgentLab configuration for the general planner."""

    agent_name: str = "LhicFullModelAgent"
    model: str = ""
    model_base_url: str = DEFAULT_BASE_URL
    model_api_key_env: str = "OPENAI_API_KEY"
    seed: int = 0
    temperature: float = 0.0
    request_timeout_seconds: float = 60.0
    max_observation_chars: int = 120_000
    max_planner_attempts: int = 2
    max_steps: int = 50
    enable_semantic_fast_path: bool = True

    def validate(self) -> None:
        if not self.model.strip():
            raise ValueError("The full agent requires a non-empty model name.")
        if not self.model_api_key_env.strip():
            raise ValueError("The full agent requires a model API-key environment variable name.")
        if not os.environ.get(self.model_api_key_env):
            raise ValueError(
                f"The full agent requires credential environment variable {self.model_api_key_env}."
            )
        _validate_model_base_url(self.model_base_url)
        if not 0 <= self.temperature <= 2:
            raise ValueError("temperature must be between 0 and 2.")
        if self.max_steps < 1 or self.max_observation_chars < 1:
            raise ValueError("max_steps and max_observation_chars must be positive.")
        if self.max_planner_attempts < 1 or self.max_planner_attempts > 3:
            raise ValueError("max_planner_attempts must be between 1 and 3.")
        if self.request_timeout_seconds <= 0:
            raise ValueError("request_timeout_seconds must be positive.")

    def make_agent(self) -> bgym.Agent:
        self.validate()
        return LhicFullAgent(
            model=self.model,
            model_base_url=self.model_base_url,
            model_api_key_env=self.model_api_key_env,
            seed=self.seed,
            temperature=self.temperature,
            request_timeout_seconds=self.request_timeout_seconds,
            max_observation_chars=self.max_observation_chars,
            max_planner_attempts=self.max_planner_attempts,
            max_steps=self.max_steps,
            enable_semantic_fast_path=self.enable_semantic_fast_path,
        )

    def set_reproducibility_mode(self) -> None:
        self.temperature = 0.0

    def prepare(self) -> None:
        self.validate()

    def close(self) -> None:
        return None


class OpenAICompatiblePlanner:
    """Minimal endpoint-neutral client for the OpenAI chat-completions contract."""

    def __init__(
        self,
        *,
        model: str,
        base_url: str,
        api_key: str,
        seed: int,
        temperature: float,
        timeout_seconds: float,
        max_attempts: int,
    ) -> None:
        self.model = model
        validated_base_url = _validate_model_base_url(base_url)
        self.endpoint = validated_base_url.rstrip("/") + "/chat/completions"
        self.api_key = api_key
        self.seed = seed
        self.temperature = temperature
        self.timeout_seconds = timeout_seconds
        self.max_attempts = max_attempts

    def plan(self, observation: dict[str, Any]) -> PlannedAction:
        messages: list[dict[str, str]] = [
            {
                "role": "system",
                "content": (
                    "You are a general browser task planner operating BrowserGym. "
                    "Choose the next action from the current observation.\n" + _ACTION_SPEC
                ),
            },
            {
                "role": "user",
                "content": json.dumps(observation, ensure_ascii=False, sort_keys=True),
            },
        ]
        validation_error = ""
        for attempt in range(self.max_attempts):
            if validation_error:
                messages.append(
                    {
                        "role": "user",
                        "content": "The prior response was rejected: " + validation_error,
                    }
                )
            payload = {
                "model": self.model,
                "messages": messages,
                "temperature": self.temperature,
                "seed": self.seed,
            }
            raw = self._post(payload)
            content = _extract_model_content(raw)
            try:
                return _validate_model_action(content)
            except PlannerError as error:
                messages.append({"role": "assistant", "content": content})
                validation_error = str(error)
                if attempt + 1 == self.max_attempts:
                    raise PlannerError(
                        f"Model returned invalid action JSON after {self.max_attempts} attempt(s): "
                        f"{validation_error}"
                    ) from error
        raise AssertionError("unreachable")

    def _post(self, payload: dict[str, Any]) -> dict[str, Any]:
        request = urllib.request.Request(
            self.endpoint,
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read(MAX_MODEL_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as error:
            raise PlannerError(f"Model endpoint returned HTTP {error.code}.") from error
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise PlannerError(f"Model endpoint request failed: {type(error).__name__}.") from error
        if len(body) > MAX_MODEL_RESPONSE_BYTES:
            raise PlannerError(
                f"Model endpoint response exceeds {MAX_MODEL_RESPONSE_BYTES} bytes."
            )
        try:
            decoded = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PlannerError("Model endpoint returned a non-JSON response.") from error
        if not isinstance(decoded, dict):
            raise PlannerError("Model endpoint response must be a JSON object.")
        return decoded


class LhicFullAgent(bgym.Agent):
    """Semantic fast path plus schema-constrained general model planner."""

    def __init__(
        self,
        *,
        model: str,
        model_base_url: str = DEFAULT_BASE_URL,
        model_api_key_env: str = "OPENAI_API_KEY",
        seed: int = 0,
        temperature: float = 0.0,
        request_timeout_seconds: float = 60.0,
        max_observation_chars: int = 120_000,
        max_planner_attempts: int = 2,
        max_steps: int = 50,
        enable_semantic_fast_path: bool = True,
        planner: Any | None = None,
    ) -> None:
        api_key = os.environ.get(model_api_key_env)
        if planner is None and not api_key:
            raise ValueError(
                f"The full agent requires credential environment variable {model_api_key_env}."
            )
        self.model = model
        self.seed = seed
        self.max_observation_chars = max_observation_chars
        self.max_steps = max_steps
        self.enable_semantic_fast_path = enable_semantic_fast_path
        self._planner = planner or OpenAICompatiblePlanner(
            model=model,
            base_url=model_base_url,
            api_key=str(api_key),
            seed=seed,
            temperature=temperature,
            timeout_seconds=request_timeout_seconds,
            max_attempts=max_planner_attempts,
        )
        self._semantic_state: dict[tuple[str, str], PlanState] = {}
        self._pending: dict[tuple[str, str], _PendingAction] = {}
        self._receipts: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self._issued_steps: dict[tuple[str, str], int] = {}
        self._blocked: dict[tuple[str, str], str] = {}
        self._model_calls = 0
        self.action_set = bgym.HighLevelActionSet(
            ["bid", "nav", "tab", "chat", "infeas"], multiaction=False
        )

    def get_action(self, obs: Any) -> tuple[str, dict[str, Any]]:
        goal = str(obs.get("goal", ""))
        task_id = str(obs.get("task_id") or obs.get("taskId") or "")
        key = (task_id, goal)
        if key in self._blocked:
            return self._infeasible(key, self._blocked[key])

        prior_receipt: dict[str, Any] | None = None
        pending = self._pending.pop(key, None)
        if pending is not None:
            if obs.get("last_action") != pending.command:
                return self._block(
                    key,
                    "BrowserGym did not echo the exact pending action; execution is unverified.",
                )
            action_error = _action_error_message(obs.get("last_action_error"))
            prior_receipt = {
                "receiptId": pending.receipt_id,
                "actionSha256": _sha256_text(pending.command),
                "status": "failed" if action_error else "succeeded",
                "source": pending.source,
            }
            if action_error:
                prior_receipt["error"] = action_error[:500]
            elif pending.semantic_next_state is not None:
                self._semantic_state[key] = pending.semantic_next_state
            self._receipts.setdefault(key, []).append(prior_receipt)

        step = self._issued_steps.get(key, 0)
        if step >= self.max_steps:
            return self._block(key, f"Agent step limit {self.max_steps} reached.")

        pruned_html = str(obs.get("pruned_html", ""))
        semantic_action_failed = (
            pending is not None
            and pending.source == "semantic-fast-path"
            and prior_receipt is not None
            and prior_receipt["status"] == "failed"
        )
        if self.enable_semantic_fast_path and not semantic_action_failed:
            semantic_state = self._semantic_state.get(key, PlanState())
            semantic = propose_plan_action(goal, pruned_html, semantic_state)
            if not semantic.decision.action.startswith(("noop(", "report_infeasible(")):
                return self._issue(
                    key=key,
                    command=semantic.decision.action,
                    source="semantic-fast-path",
                    reason=semantic.decision.reason,
                    semantic_next_state=semantic.next_state,
                    prior_receipt=prior_receipt,
                )

        planner_observation = self._planner_observation(obs, key, prior_receipt)
        try:
            self._model_calls += 1
            planned = self._planner.plan(planner_observation)
        except PlannerError as error:
            return self._block(key, f"Model planner failed closed: {error}")
        return self._issue(
            key=key,
            command=planned.command,
            source="model-planner",
            reason=planned.reason,
            semantic_next_state=None,
            prior_receipt=prior_receipt,
            action_name=planned.name,
        )

    def _planner_observation(
        self,
        obs: Any,
        key: tuple[str, str],
        prior_receipt: dict[str, Any] | None,
    ) -> dict[str, Any]:
        html = str(obs.get("pruned_html", ""))
        axtree = str(obs.get("axtree_txt") or obs.get("axtree") or "")
        remaining = self.max_observation_chars
        html = html[:remaining]
        remaining -= len(html)
        axtree = axtree[:remaining]
        return {
            "goal": key[1],
            "taskId": key[0],
            "url": str(obs.get("url", "")),
            "prunedHtml": html,
            "accessibilityTree": axtree,
            "openPages": obs.get("open_pages_urls", []),
            "step": self._issued_steps.get(key, 0),
            "seed": self.seed,
            "latestReceipt": prior_receipt,
            "recentReceipts": self._receipts.get(key, [])[-5:],
        }

    def _issue(
        self,
        *,
        key: tuple[str, str],
        command: str,
        source: str,
        reason: str,
        semantic_next_state: PlanState | None,
        prior_receipt: dict[str, Any] | None,
        action_name: str | None = None,
    ) -> tuple[str, dict[str, Any]]:
        step = self._issued_steps.get(key, 0)
        receipt_id = _sha256_text(
            json.dumps([key[0], key[1], step, command, self.seed], ensure_ascii=False)
        )[:20]
        self._pending[key] = _PendingAction(
            command=command,
            source=source,
            receipt_id=receipt_id,
            semantic_next_state=semantic_next_state,
        )
        self._issued_steps[key] = step + 1
        return (
            command,
            bgym.AgentInfo(
                think=f"{source} selected a schema-validated browser action: {reason}",
                stats={
                    "lhic_full_agent": 1,
                    "actions": step + 1,
                    "model_calls": self._model_calls,
                    "receipts": len(self._receipts.get(key, [])),
                },
                extra_info={
                    "source": source,
                    "model": self.model,
                    "seed": self.seed,
                    "step": step,
                    "actionName": action_name,
                    "pendingReceiptId": receipt_id,
                    "pendingActionSha256": _sha256_text(command),
                    "priorReceipt": prior_receipt,
                },
            ),
        )

    def _block(self, key: tuple[str, str], reason: str) -> tuple[str, dict[str, Any]]:
        self._blocked[key] = reason
        return self._infeasible(key, reason)

    def _infeasible(
        self, key: tuple[str, str], reason: str
    ) -> tuple[str, dict[str, Any]]:
        command = f"report_infeasible({json.dumps(reason)})"
        return (
            command,
            bgym.AgentInfo(
                think=reason,
                stats={
                    "lhic_full_agent": 1,
                    "actions": self._issued_steps.get(key, 0),
                    "model_calls": self._model_calls,
                    "receipts": len(self._receipts.get(key, [])),
                },
                extra_info={
                    "blocked": True,
                    "model": self.model,
                    "seed": self.seed,
                    "reason": reason,
                },
            ),
        )


def _extract_model_content(response: dict[str, Any]) -> str:
    try:
        content = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as error:
        raise PlannerError("Model response lacks choices[0].message.content.") from error
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        texts = [part.get("text", "") for part in content if isinstance(part, dict)]
        joined = "".join(texts)
        if joined.strip():
            return joined
    raise PlannerError("Model response content is empty or unsupported.")


def _validate_model_action(content: str) -> PlannedAction:
    try:
        value = json.loads(content)
    except json.JSONDecodeError as error:
        raise PlannerError("Response is not valid JSON.") from error
    if not isinstance(value, dict) or set(value) != {"action", "reason"}:
        raise PlannerError("Top-level keys must be exactly action and reason.")
    reason = _required_string(value["reason"], "reason", maximum=1000)
    action = value["action"]
    if not isinstance(action, dict) or set(action) != {"name", "args"}:
        raise PlannerError("action keys must be exactly name and args.")
    name = _required_string(action["name"], "action.name", maximum=64)
    if name not in _ALLOWED_ACTIONS:
        raise PlannerError(f"Unsupported action name: {name}.")
    args = action["args"]
    if not isinstance(args, dict):
        raise PlannerError("action.args must be an object.")
    command = _format_validated_action(name, args)
    return PlannedAction(command=command, name=name, reason=reason)


def _format_validated_action(name: str, args: dict[str, Any]) -> str:
    def exact(expected: set[str]) -> None:
        if set(args) != expected:
            raise PlannerError(f"{name} arguments must be exactly {sorted(expected)}.")

    def text(field: str, maximum: int = 20_000) -> str:
        return _required_string(args.get(field), f"action.args.{field}", maximum=maximum)

    if name in {"go_back", "go_forward", "new_tab", "tab_close"}:
        exact(set())
        return f"{name}()"
    if name in {"click", "hover"}:
        exact({"bid"})
        return f"{name}({json.dumps(text('bid', 500))})"
    if name == "fill":
        exact({"bid", "value"})
        return f"fill({json.dumps(text('bid', 500))}, {json.dumps(text('value'))})"
    if name == "select_option":
        exact({"bid", "options"})
        bid = text("bid", 500)
        options = args["options"]
        if isinstance(options, str):
            validated_options: str | list[str] = _required_string(options, "options")
        elif isinstance(options, list) and 0 < len(options) <= 100:
            validated_options = [
                _required_string(option, "options[]") for option in options
            ]
        else:
            raise PlannerError("select_option options must be a string or non-empty string array.")
        return f"select_option({json.dumps(bid)}, {json.dumps(validated_options)})"
    if name == "press":
        exact({"bid", "key_comb"})
        return f"press({json.dumps(text('bid', 500))}, {json.dumps(text('key_comb', 100))})"
    if name == "drag_and_drop":
        exact({"from_bid", "to_bid"})
        return (
            f"drag_and_drop({json.dumps(text('from_bid', 500))}, "
            f"{json.dumps(text('to_bid', 500))})"
        )
    if name == "scroll":
        exact({"delta_x", "delta_y"})
        x = _finite_number(args["delta_x"], "delta_x")
        y = _finite_number(args["delta_y"], "delta_y")
        if abs(x) > 10_000 or abs(y) > 10_000:
            raise PlannerError("scroll deltas must be between -10000 and 10000.")
        return f"scroll({json.dumps(x)}, {json.dumps(y)})"
    if name == "goto":
        exact({"url"})
        url = text("url", 10_000)
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise PlannerError("goto URL must be absolute HTTP(S).")
        return f"goto({json.dumps(url)})"
    if name == "tab_focus":
        exact({"index"})
        index = args["index"]
        if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index <= 100:
            raise PlannerError("tab_focus index must be an integer between 0 and 100.")
        return f"tab_focus({index})"
    if name == "send_msg_to_user":
        exact({"text"})
        return f"send_msg_to_user({json.dumps(text('text'))})"
    if name == "report_infeasible":
        exact({"reason"})
        return f"report_infeasible({json.dumps(text('reason', 1000))})"
    raise PlannerError(f"Unsupported action name: {name}.")


def _required_string(value: Any, field: str, maximum: int = 20_000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise PlannerError(f"{field} must be a non-empty string of at most {maximum} characters.")
    return value


def _finite_number(value: Any, field: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise PlannerError(f"{field} must be a number.")
    if value != value or value in {float("inf"), float("-inf")}:
        raise PlannerError(f"{field} must be finite.")
    return value

def _validate_model_base_url(value: str) -> str:
    parsed = urlparse(value)
    if (
        parsed.username is not None
        or parsed.password is not None
        or not parsed.hostname
    ):
        raise ValueError("The model base URL cannot contain credentials.")
    if parsed.scheme == "https":
        return value
    if parsed.scheme == "http" and _is_loopback_hostname(parsed.hostname):
        return value
    raise ValueError(
        "The model base URL must use HTTPS, except for a loopback HTTP endpoint."
    )


def _is_loopback_hostname(hostname: str) -> bool:
    if hostname.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(hostname).is_loopback
    except ValueError:
        return False


def _action_error_message(value: object) -> str | None:
    if value is None or value is False:
        return None
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, (dict, list, tuple, set)) and not value:
        return None
    return str(value)


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
