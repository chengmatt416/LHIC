"""Policy- and schema-hardened adapter for the original tau-bench API."""

from __future__ import annotations

import json
from typing import Any, Mapping, Optional

from litellm import completion
from tau_bench.agents.base import Agent
from tau_bench.envs.base import Env
from tau_bench.types import Action, RESPOND_ACTION_NAME, SolveResult

from tool_agent_core import (
    ToolCallValidationError,
    build_system_prompt,
    validate_tool_call,
    validation_feedback,
)


class LhicTauBenchAgent(Agent):
    """Legacy tau agent that validates every action before ``env.step``."""

    def __init__(self, tools_info: list[dict[str, Any]], wiki: str, model: str,
                 provider: str, temperature: float = 0.0,
                 schema_retries: int = 2) -> None:
        if schema_retries < 0:
            raise ValueError("schema_retries must be non-negative")
        self.tools_info = tools_info
        self.wiki = wiki
        self.model = model
        self.provider = provider
        self.temperature = temperature
        self.schema_retries = schema_retries

    def solve(self, env: Env, task_index: Optional[int] = None,
              max_num_steps: int = 30) -> SolveResult:
        total_cost = 0.0
        reset = env.reset(task_index=task_index)
        observation = reset.observation
        info = reset.info.model_dump()
        reward = 0.0
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": build_system_prompt(self.wiki)},
            {"role": "user", "content": observation},
        ]
        last_tool_failed = False

        for _ in range(max_num_steps):
            next_message, request_cost = self._next_valid_message(
                messages, last_tool_failed
            )
            total_cost += request_cost
            action = _message_to_action(next_message, self.tools_info)
            response = env.step(action)
            reward = response.reward
            info = {**info, **response.info.model_dump()}
            if action.name == RESPOND_ACTION_NAME:
                messages.extend([next_message, {"role": "user", "content": response.observation}])
                last_tool_failed = False
            else:
                tool_call = next_message["tool_calls"][0]
                messages.extend([
                    next_message,
                    {"role": "tool", "tool_call_id": tool_call["id"],
                     "name": tool_call["function"]["name"],
                     "content": response.observation},
                ])
                last_tool_failed = _looks_like_tool_error(response.observation)
            if response.done:
                break
        info["lhic_agent_cost_usd"] = total_cost
        return SolveResult(reward=reward, info=info, messages=messages,
                           total_cost=total_cost)

    def _next_valid_message(self, messages: list[dict[str, Any]],
                            last_tool_failed: bool) -> tuple[dict[str, Any], float]:
        request_cost = 0.0
        feedback: Optional[str] = None
        for attempt in range(self.schema_retries + 1):
            prompt = [dict(message) for message in messages]
            safeguards: list[str] = []
            if last_tool_failed:
                safeguards.append(
                    "The latest tool result is an execution error. Assume no state "
                    "change unless explicitly confirmed; correct the cause or choose "
                    "another policy-compliant path and never claim success."
                )
            if feedback:
                safeguards.append(feedback)
            if safeguards:
                prompt[0]["content"] = (
                    str(prompt[0].get("content", ""))
                    + "\n<turn_safeguard>\n" + "\n".join(safeguards)
                    + "\n</turn_safeguard>"
                )
            response = completion(messages=prompt, model=self.model,
                                  custom_llm_provider=self.provider,
                                  tools=self.tools_info,
                                  temperature=self.temperature)
            request_cost += _response_cost(response)
            draft = response.choices[0].message.model_dump()
            try:
                return _validated_message(draft, self.tools_info), request_cost
            except ToolCallValidationError as error:
                if attempt == self.schema_retries:
                    return ({"role": "assistant", "content":
                             "I could not form a policy-compliant tool request from the "
                             "available information. Please clarify the required details "
                             "or ask for a human agent."}, request_cost)
                feedback = validation_feedback(error)
        raise AssertionError("schema repair loop did not return")


def _validated_message(message: Mapping[str, Any],
                       schemas: list[dict[str, Any]]) -> dict[str, Any]:
    calls = message.get("tool_calls") or []
    content = message.get("content")
    if not calls:
        if not isinstance(content, str) or not content.strip():
            raise ToolCallValidationError("a response without a tool call must contain text")
        return {"role": "assistant", "content": content.strip()}
    if not isinstance(calls, list) or len(calls) != 1:
        raise ToolCallValidationError("exactly one sequential tool call is allowed per turn")
    call = calls[0]
    function = call.get("function") if isinstance(call, Mapping) else None
    if not isinstance(function, Mapping):
        raise ToolCallValidationError("tool call is missing its function object")
    validated = validate_tool_call(schemas, function.get("name"),
                                   function.get("arguments"))
    call_id = call.get("id")
    if not isinstance(call_id, str) or not call_id:
        raise ToolCallValidationError("tool call must have a non-empty id")
    return {"role": "assistant", "content": None, "tool_calls": [{
        "id": call_id, "type": "function", "function": {
            "name": validated.name,
            "arguments": json.dumps(validated.arguments, separators=(",", ":"),
                                    ensure_ascii=False),
        }}]}


def _message_to_action(message: Mapping[str, Any],
                       schemas: list[dict[str, Any]]) -> Action:
    calls = message.get("tool_calls") or []
    if not calls:
        return Action(name=RESPOND_ACTION_NAME, kwargs={"content": message["content"]})
    function = calls[0]["function"]
    validated = validate_tool_call(schemas, function["name"], function["arguments"])
    return Action(name=validated.name, kwargs=validated.arguments)


def _looks_like_tool_error(observation: object) -> bool:
    if not isinstance(observation, str):
        return False
    normalized = observation.strip().lower()
    if not normalized:
        return True
    if normalized.startswith(("error", "exception", "invalid request", "tool failed")):
        return True
    try:
        parsed = json.loads(observation)
    except (TypeError, ValueError, json.JSONDecodeError):
        return False
    return isinstance(parsed, dict) and any(
        key in parsed for key in ("error", "errors", "exception")
    )


def _response_cost(response: object) -> float:
    hidden = getattr(response, "_hidden_params", None)
    if not isinstance(hidden, Mapping):
        return 0.0
    value = hidden.get("response_cost")
    return float(value) if isinstance(value, (int, float)) else 0.0
