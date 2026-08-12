"""Policy- and schema-hardened half-duplex agent for tau3-bench.

This module depends only on tau3-bench (the ``tau2`` Python package) and is
loaded by ``run_tau3.py``. It never consumes task evaluation criteria.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional
from uuid import uuid4

from pydantic import Field

from tau2.agent.base_agent import ValidAgentInputMessage, is_valid_agent_history_message
from tau2.agent.llm_agent import LLMAgent, LLMAgentState
from tau2.data_model.message import (
    AssistantMessage,
    Message,
    MultiToolMessage,
    SystemMessage,
    ToolMessage,
    UserMessage,
)
from tau2.environment.tool import Tool
from tau2.utils.llm_utils import generate

from tool_agent_core import (
    ToolCallValidationError,
    build_system_prompt,
    validate_tool_call,
    validation_feedback,
)


class LhicTau3State(LLMAgentState):
    """Conversation state kept across user and environment turns."""

    consecutive_tool_errors: int = Field(default=0, ge=0)
    rejected_drafts: int = Field(default=0, ge=0)


class LhicTau3Agent(LLMAgent[LhicTau3State]):
    """Sequential tool agent with pre-execution schema validation and repair."""

    def __init__(
        self,
        tools: list[Tool],
        domain_policy: str,
        llm: str,
        llm_args: Optional[dict[str, Any]] = None,
        schema_retries: int = 2,
    ) -> None:
        if schema_retries < 0:
            raise ValueError("schema_retries must be non-negative")
        super().__init__(
            tools=tools,
            domain_policy=domain_policy,
            llm=llm,
            llm_args=llm_args,
        )
        self.schema_retries = schema_retries
        self._tool_schemas = [tool.openai_schema for tool in tools]

    @property
    def system_prompt(self) -> str:
        return build_system_prompt(self.domain_policy)

    def get_init_state(
        self, message_history: Optional[list[Message]] = None
    ) -> LhicTau3State:
        history = list(message_history or [])
        if not all(is_valid_agent_history_message(message) for message in history):
            raise ValueError(
                "Message history may contain only user, assistant, and tool messages to the agent."
            )
        return LhicTau3State(
            system_messages=[SystemMessage(role="system", content=self.system_prompt)],
            messages=history,
        )

    def generate_next_message(
        self,
        message: ValidAgentInputMessage,
        state: LhicTau3State,
    ) -> tuple[AssistantMessage, LhicTau3State]:
        if isinstance(message, UserMessage) and message.is_audio:
            raise ValueError("Audio input requires a full-duplex tau3 agent.")

        incoming = (
            list(message.tool_messages)
            if isinstance(message, MultiToolMessage)
            else [message]
        )
        state.messages.extend(incoming)
        errors = [
            item
            for item in incoming
            if isinstance(item, ToolMessage) and item.error
        ]
        if errors:
            state.consecutive_tool_errors += len(errors)
        elif any(isinstance(item, ToolMessage) for item in incoming):
            state.consecutive_tool_errors = 0

        repair_message: Optional[SystemMessage] = None
        total_cost = 0.0
        total_generation_seconds = 0.0
        total_usage: dict[str, int | float] = {}
        for attempt in range(self.schema_retries + 1):
            messages = state.system_messages + state.messages
            if errors:
                messages = messages + [
                    SystemMessage(
                        role="system",
                        content=(
                            "The latest tool result is an execution error. Assume no state "
                            "change unless the result explicitly confirms one. Use the error "
                            "details to correct the call, gather missing data, choose another "
                            "policy-compliant path, or explain the blocker; never claim success."
                        ),
                    )
                ]
            if repair_message is not None:
                messages = messages + [repair_message]

            draft = generate(
                model=self.llm,
                tools=self.tools,
                messages=messages,
                call_name="lhic_tau3_agent_response",
                **self.llm_args,
            )
            if isinstance(draft.cost, (int, float)) and not isinstance(draft.cost, bool):
                total_cost += float(draft.cost)
            if isinstance(draft.generation_time_seconds, (int, float)):
                total_generation_seconds += float(draft.generation_time_seconds)
            if isinstance(draft.usage, Mapping):
                for key, value in draft.usage.items():
                    if isinstance(value, (int, float)) and not isinstance(value, bool):
                        total_usage[key] = total_usage.get(key, 0) + value
            try:
                assistant = self._validated_message(draft)
            except ToolCallValidationError as error:
                state.rejected_drafts += 1
                if attempt == self.schema_retries:
                    assistant = AssistantMessage(
                        role="assistant",
                        content=(
                            "I could not form a policy-compliant tool request from the "
                            "available information. Please clarify the required details or "
                            "ask for a human agent."
                        ),
                    )
                    break
                repair_message = SystemMessage(
                    role="system", content=validation_feedback(error)
                )
                continue
            break

        assistant = assistant.model_copy(
            update={
                "cost": total_cost,
                "usage": total_usage or None,
                "generation_time_seconds": total_generation_seconds,
            }
        )
        state.messages.append(assistant)
        return assistant, state

    def _validated_message(self, draft: AssistantMessage) -> AssistantMessage:
        calls = list(draft.tool_calls or [])
        content = draft.content.strip() if isinstance(draft.content, str) else ""
        if not calls:
            if not content:
                raise ToolCallValidationError(
                    "an assistant response without a tool call must contain text"
                )
            return draft.model_copy(update={"content": content, "tool_calls": None})
        if len(calls) != 1:
            raise ToolCallValidationError(
                "exactly one sequential tool call is allowed per turn"
            )

        call = calls[0]
        validated = validate_tool_call(
            self._tool_schemas,
            call.name,
            call.arguments,
        )
        normalized_call = call.model_copy(
            update={
                "id": call.id or f"lhic-{uuid4().hex}",
                "name": validated.name,
                "arguments": validated.arguments,
                "requestor": "assistant",
            }
        )
        return draft.model_copy(update={"content": None, "tool_calls": [normalized_call]})


def create_lhic_tau3_agent(
    tools: list[Tool],
    domain_policy: str,
    llm: str,
    llm_args: Optional[dict[str, Any]] = None,
    *,
    task: Any = None,
    audio_native_config: Any = None,
    audio_taps_dir: Any = None,
    **unexpected: Any,
) -> LhicTau3Agent:
    """Create an agent for the exact tau2-bench v1.0.1 factory contract."""
    del task, audio_taps_dir
    if unexpected:
        names = ", ".join(sorted(unexpected))
        raise TypeError(f"unsupported tau2 agent factory arguments: {names}")
    if not isinstance(llm, str) or not llm.strip():
        raise ValueError("tau2 --agent-llm must be a non-empty model name")
    if llm_args is not None and not isinstance(llm_args, dict):
        raise TypeError("tau2 --agent-llm-args must decode to an object")
    if audio_native_config is not None:
        raise ValueError("lhic_policy_tool supports only text half-duplex runs")
    return LhicTau3Agent(
        tools=tools,
        domain_policy=domain_policy,
        llm=llm,
        llm_args=llm_args,
    )
