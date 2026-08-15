"""Thin OSWorld 2.0 runner interposition scaffold for LHIC-Core.

This module deliberately does not reimplement the LHIC state machine in Python.
It defines the benchmark-side hook that must sit immediately around OSWorld's
``env.step(action, sleep_after_execution)`` call. A real LHIC bridge can satisfy
the BoundaryClient protocol using the TypeScript research kernel or the product
runtime.

Official OSWorld task setup and evaluation remain outside this boundary.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol, runtime_checkable


@dataclass(frozen=True)
class DispatchContext:
    task_id: str
    action_id: str
    action_index: int
    action: str


@dataclass(frozen=True)
class StepResult:
    observation: Any
    reward: Any
    done: bool
    info: Mapping[str, Any] | Any


@runtime_checkable
class BoundaryClient(Protocol):
    """Benchmark-side contract implemented by an LHIC bridge.

    ``before_dispatch`` MUST durably persist ambiguity before returning.
    ``after_response`` records that OSWorld returned from ``env.step``; this is
    execution evidence only and must not be treated as LHIC verification.
    ``after_lost_response`` records an exception/timeout after dispatch.
    """

    def before_dispatch(self, context: DispatchContext) -> None:
        ...

    def after_response(self, context: DispatchContext, result: StepResult) -> None:
        ...

    def after_lost_response(self, context: DispatchContext, error: BaseException) -> None:
        ...


def execute_with_lhic_boundary(
    *,
    env: Any,
    boundary: BoundaryClient,
    task_id: str,
    action_index: int,
    action: str,
    sleep_after_execution: float,
) -> tuple[Any, Any, bool, Any]:
    """Execute one OSWorld action through the LHIC trust boundary.

    The function preserves OSWorld's return tuple unchanged. It does not call
    the benchmark evaluator and does not modify task state beyond the original
    ``env.step`` action.
    """

    context = DispatchContext(
        task_id=task_id,
        action_id=f"osworld:{task_id}:{action_index}",
        action_index=action_index,
        action=action,
    )

    # Critical ordering invariant: durable ambiguity must exist before the
    # physical OSWorld action is dispatched.
    boundary.before_dispatch(context)

    try:
        observation, reward, done, info = env.step(action, sleep_after_execution)
    except BaseException as error:
        boundary.after_lost_response(context, error)
        raise

    result = StepResult(
        observation=observation,
        reward=reward,
        done=bool(done),
        info=info,
    )
    boundary.after_response(context, result)
    return observation, reward, done, info
