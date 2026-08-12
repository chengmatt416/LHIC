"""LHIC Benchmark Metrics Tracker

Tracks comprehensive metrics for benchmark submissions:
- Success rate
- Pass@k
- Tokens used
- Model calls
- Latency
- Verifier coverage
- Fast Path ratio
- Skill reuse rate
- Unsafe action rate
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any, Optional


@dataclass
class TaskMetrics:
    """Metrics for a single task execution."""

    task_id: str
    goal: str

    # Outcome
    success: bool
    verified: bool
    verification_evidence: list[str]

    # Cost
    tokens_used: int
    model_calls: int
    wall_clock_ms: float

    # LHIC-specific
    fast_path_actions: int
    slow_path_actions: int
    skill_reuses: int
    unsafe_actions: int

    # Actions taken
    total_actions: int
    action_history: list[dict[str, Any]]

    # Timestamps
    start_time: float
    end_time: float


@dataclass
class BenchmarkMetrics:
    """Aggregate metrics for a benchmark run."""

    benchmark: str
    model_name: str
    agent_type: str  # "baseline" or "lhic"

    # Task results
    task_metrics: list[TaskMetrics] = field(default_factory=list)

    # Aggregate metrics (computed)
    @property
    def total_tasks(self) -> int:
        return len(self.task_metrics)

    @property
    def successful_tasks(self) -> int:
        return sum(1 for t in self.task_metrics if t.success)

    @property
    def success_rate(self) -> float:
        return self.successful_tasks / max(1, self.total_tasks)

    @property
    def pass_at_1(self) -> float:
        return self.success_rate

    @property
    def total_tokens(self) -> int:
        return sum(t.tokens_used for t in self.task_metrics)

    @property
    def total_model_calls(self) -> int:
        return sum(t.model_calls for t in self.task_metrics)

    @property
    def avg_latency_ms(self) -> float:
        if not self.task_metrics:
            return 0.0
        return sum(t.wall_clock_ms for t in self.task_metrics) / len(self.task_metrics)

    @property
    def fast_path_ratio(self) -> float:
        total_actions = sum(t.total_actions for t in self.task_metrics)
        fast_actions = sum(t.fast_path_actions for t in self.task_metrics)
        return fast_actions / max(1, total_actions)

    @property
    def skill_reuse_rate(self) -> float:
        total_tasks = max(1, self.total_tasks)
        reuses = sum(t.skill_reuses for t in self.task_metrics)
        return reuses / total_tasks

    @property
    def verification_pass_rate(self) -> bool:
        verified = sum(1 for t in self.task_metrics if t.verified)
        return verified / max(1, self.total_tasks)

    @property
    def unsafe_action_rate(self) -> float:
        total_actions = sum(t.total_actions for t in self.task_metrics)
        unsafe = sum(t.unsafe_actions for t in self.task_metrics)
        return unsafe / max(1, total_actions)

    @property
    def tokens_per_task(self) -> float:
        return self.total_tokens / max(1, self.total_tasks)

    @property
    def model_calls_per_task(self) -> float:
        return self.total_model_calls / max(1, self.total_tasks)


class MetricsTracker:
    """Tracks metrics for benchmark runs."""

    def __init__(self, benchmark: str, model_name: str, agent_type: str):
        self.metrics = BenchmarkMetrics(
            benchmark=benchmark,
            model_name=model_name,
            agent_type=agent_type,
        )
        self._current_task: Optional[TaskMetrics] = None
        self._task_start_time: float = 0

    def start_task(self, task_id: str, goal: str) -> None:
        """Start tracking a new task."""
        self._task_start_time = time.time()
        self._current_task = TaskMetrics(
            task_id=task_id,
            goal=goal,
            success=False,
            verified=False,
            verification_evidence=[],
            tokens_used=0,
            model_calls=0,
            wall_clock_ms=0,
            fast_path_actions=0,
            slow_path_actions=0,
            skill_reuses=0,
            unsafe_actions=0,
            total_actions=0,
            action_history=[],
            start_time=self._task_start_time,
            end_time=0,
        )

    def record_action(
        self,
        action: str,
        path: str,  # "fast" or "slow"
        tokens: int = 0,
        unsafe: bool = False,
        skill_reuse: bool = False,
    ) -> None:
        """Record an action taken."""
        if not self._current_task:
            return

        self._current_task.total_actions += 1
        self._current_task.action_history.append({
            "action": action,
            "path": path,
            "tokens": tokens,
            "unsafe": unsafe,
            "timestamp": time.time(),
        })

        if path == "fast":
            self._current_task.fast_path_actions += 1
        else:
            self._current_task.slow_path_actions += 1
            self._current_task.model_calls += 1

        self._current_task.tokens_used += tokens

        if unsafe:
            self._current_task.unsafe_actions += 1

        if skill_reuse:
            self._current_task.skill_reuses += 1

    def end_task(
        self,
        success: bool,
        verified: bool = False,
        verification_evidence: list[str] = None,
    ) -> None:
        """End tracking current task."""
        if not self._current_task:
            return

        self._current_task.success = success
        self._current_task.verified = verified
        self._current_task.verification_evidence = verification_evidence or []
        self._current_task.end_time = time.time()
        self._current_task.wall_clock_ms = (
            (self._current_task.end_time - self._current_task.start_time) * 1000
        )

        self.metrics.task_metrics.append(self._current_task)
        self._current_task = None

    def get_summary(self) -> dict[str, Any]:
        """Get summary of all metrics."""
        return {
            "benchmark": self.metrics.benchmark,
            "model_name": self.metrics.model_name,
            "agent_type": self.metrics.agent_type,
            "total_tasks": self.metrics.total_tasks,
            "successful_tasks": self.metrics.successful_tasks,
            "success_rate": self.metrics.success_rate,
            "pass_at_1": self.metrics.pass_at_1,
            "total_tokens": self.metrics.total_tokens,
            "tokens_per_task": self.metrics.tokens_per_task,
            "total_model_calls": self.metrics.total_model_calls,
            "model_calls_per_task": self.metrics.model_calls_per_task,
            "avg_latency_ms": self.metrics.avg_latency_ms,
            "fast_path_ratio": self.metrics.fast_path_ratio,
            "skill_reuse_rate": self.metrics.skill_reuse_rate,
            "verification_pass_rate": self.metrics.verification_pass_rate,
            "unsafe_action_rate": self.metrics.unsafe_action_rate,
        }

    def save(self, filepath: str) -> None:
        """Save metrics to JSON file."""
        output = {
            "summary": self.get_summary(),
            "tasks": [
                {
                    "task_id": t.task_id,
                    "goal": t.goal,
                    "success": t.success,
                    "verified": t.verified,
                    "tokens_used": t.tokens_used,
                    "model_calls": t.model_calls,
                    "wall_clock_ms": t.wall_clock_ms,
                    "fast_path_actions": t.fast_path_actions,
                    "slow_path_actions": t.slow_path_actions,
                    "skill_reuses": t.skill_reuses,
                    "unsafe_actions": t.unsafe_actions,
                    "total_actions": t.total_actions,
                }
                for t in self.metrics.task_metrics
            ],
        }

        with open(filepath, "w") as f:
            json.dump(output, f, indent=2)

    def print_summary(self) -> None:
        """Print summary table."""
        summary = self.get_summary()

        print("\n" + "=" * 70)
        print(f"Benchmark: {summary['benchmark']}")
        print(f"Model: {summary['model_name']}")
        print(f"Agent: {summary['agent_type']}")
        print("=" * 70)

        print(f"\n{'Metric':<35} {'Value':>20}")
        print("-" * 55)

        print(f"{'Success Rate':<35} {summary['success_rate']:>19.1%}")
        print(f"{'Pass@1':<35} {summary['pass_at_1']:>19.1%}")
        print(f"{'Total Tokens':<35} {summary['total_tokens']:>20,}")
        print(f"{'Tokens per Task':<35} {summary['tokens_per_task']:>19.1f}")
        print(f"{'Model Calls':<35} {summary['total_model_calls']:>20,}")
        print(f"{'Model Calls per Task':<35} {summary['model_calls_per_task']:>19.1f}")
        print(f"{'Avg Latency (ms)':<35} {summary['avg_latency_ms']:>19.1f}")
        print(f"{'Fast Path Ratio':<35} {summary['fast_path_ratio']:>19.1%}")
        print(f"{'Skill Reuse Rate':<35} {summary['skill_reuse_rate']:>19.1%}")
        print(f"{'Verification Pass Rate':<35} {summary['verification_pass_rate']:>19.1%}")
        print(f"{'Unsafe Action Rate':<35} {summary['unsafe_action_rate']:>19.1%}")

        print("\n" + "=" * 70)
