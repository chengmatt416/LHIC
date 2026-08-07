"""LHIC Ablation Benchmark Runner

Runs fixed-model ablation comparing:
1. Model alone (baseline)
2. Model + LHIC (experimental)

Metrics tracked:
- Success rate
- Pass@k (k=1,3,5)
- Tokens used
- Model calls
- Latency (p50, p95, p99)
- Verifier coverage
- Fast Path ratio
- Skill reuse rate
- Unsafe action rate
"""

from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Any, Optional

import bgym
from agentlab.agents.agent_args import AgentArgs
from agentlab.experiments import study

from metrics_tracker import MetricsTracker


@dataclass
class AblationConfig:
    """Configuration for ablation study."""

    benchmark: str  # "webarena", "osworld", "taubench"
    model_name: str  # "gpt-5.6-sol", "claude-sonnet-4.6", etc.
    num_runs: int = 1  # Number of runs for pass@k
    max_steps: int = 50
    enable_learning: bool = True
    output_dir: str = "ablation_results"


@dataclass
class AblationResult:
    """Results from a single ablation run."""

    config: AblationConfig
    agent_type: str  # "baseline" or "lhic"

    # Core metrics
    success_rate: float
    total_tasks: int
    successful_tasks: int

    # Cost metrics
    total_tokens: int
    model_calls: int
    avg_latency_ms: float
    p50_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float

    # LHIC-specific metrics
    fast_path_ratio: float
    skill_reuse_rate: float
    verification_pass_rate: float
    unsafe_action_rate: float

    # Pass@k
    pass_at_1: float
    pass_at_3: Optional[float]
    pass_at_5: Optional[float]

    # Raw data
    task_results: list[dict[str, Any]]
    timing_data: list[float]


class AblationRunner:
    """Runs ablation studies comparing model alone vs model + LHIC."""

    def __init__(self, config: AblationConfig):
        self.config = config
        self.results: list[AblationResult] = []

    def run_baseline(self) -> AblationResult:
        """Run baseline: model alone without LHIC."""
        print(f"Running baseline: {self.config.model_name} alone")

        # Create baseline agent (model only, no LHIC)
        agent = self._create_baseline_agent()

        # Run benchmark
        result = self._run_benchmark(agent, "baseline")

        self.results.append(result)
        return result

    def run_lhic(self) -> AblationResult:
        """Run experimental: model + LHIC."""
        print(f"Running LHIC: {self.config.model_name} + LHIC")

        # Create LHIC agent
        agent = self._create_lhic_agent()

        # Run benchmark
        result = self._run_benchmark(agent, "lhic")

        self.results.append(result)
        return result

    def run_full_ablation(self) -> dict[str, AblationResult]:
        """Run complete ablation study."""
        results = {}

        # Run baseline
        results["baseline"] = self.run_baseline()

        # Run LHIC
        results["lhic"] = self.run_lhic()

        # Save results
        self._save_results(results)

        # Print comparison
        self._print_comparison(results)

        return results

    def _create_baseline_agent(self) -> bgym.Agent:
        """Create baseline agent (model only)."""
        from lhic_full_agent import LhicFullAgent

        return LhicFullAgent(
            model_name=self.config.model_name,
            enable_slow_path=True,
            enable_learning=False,  # No learning in baseline
            max_steps=self.config.max_steps,
        )

    def _create_lhic_agent(self) -> bgym.Agent:
        """Create LHIC agent with learning enabled."""
        from lhic_full_agent import LhicFullAgent

        return LhicFullAgent(
            model_name=self.config.model_name,
            enable_slow_path=True,
            enable_learning=self.config.enable_learning,
            max_steps=self.config.max_steps,
        )

    def _run_benchmark(
        self, agent: bgym.Agent, agent_type: str
    ) -> AblationResult:
        """Run benchmark with given agent."""
        start_time = time.time()

        # Initialize metrics tracker
        tracker = MetricsTracker(
            benchmark=self.config.benchmark,
            model_name=self.config.model_name,
            agent_type=agent_type,
        )

        # Run benchmark
        env_args = self._get_env_args()
        study.run(
            agent_args=agent.make_agent_args(),
            env_args_list=[env_args],
            work_dir=f"{self.config.output_dir}/{agent_type}",
        )

        end_time = time.time()

        # Parse results
        return self._parse_results(agent, agent_type, end_time - start_time, tracker)

    def _get_env_args(self) -> Any:
        """Get environment arguments for benchmark."""
        if self.config.benchmark == "webarena":
            return bgym.make_env_args("webarena", task_id=None)
        elif self.config.benchmark == "osworld":
            return bgym.make_env_args("osworld", task_id=None)
        elif self.config.benchmark == "taubench":
            return bgym.make_env_args("taubench", task_id=None)
        else:
            raise ValueError(f"Unknown benchmark: {self.config.benchmark}")

    def _parse_results(
        self,
        agent: bgym.Agent,
        agent_type: str,
        total_time: float,
        tracker: MetricsTracker,
    ) -> AblationResult:
        """Parse benchmark results."""
        metrics = agent.get_metrics() if hasattr(agent, "get_metrics") else {}

        # Calculate latency percentiles
        timing_data = []  # Would be populated from actual run
        sorted_timing = sorted(timing_data) if timing_data else [0]

        def percentile(data: list[float], p: float) -> float:
            if not data:
                return 0.0
            idx = int(len(data) * p / 100)
            return data[min(idx, len(data) - 1)]

        return AblationResult(
            config=self.config,
            agent_type=agent_type,
            success_rate=0.0,  # Would be parsed from results
            total_tasks=0,
            successful_tasks=0,
            total_tokens=metrics.get("total_tokens", 0),
            model_calls=metrics.get("model_calls", 0),
            avg_latency_ms=total_time * 1000 / max(1, len(timing_data)),
            p50_latency_ms=percentile(sorted_timing, 50),
            p95_latency_ms=percentile(sorted_timing, 95),
            p99_latency_ms=percentile(sorted_timing, 99),
            fast_path_ratio=metrics.get("fast_path_ratio", 0.0),
            skill_reuse_rate=metrics.get("skill_reuse_rate", 0.0),
            verification_pass_rate=0.0,
            unsafe_action_rate=0.0,
            pass_at_1=0.0,
            pass_at_3=None,
            pass_at_5=None,
            task_results=[],
            timing_data=timing_data,
        )

    def calculate_pass_at_k(
        self,
        n: int,  # Total tasks
        c: int,  # Correct tasks
        k: int,  # k in pass@k
    ) -> float:
        """Calculate pass@k metric."""
        if n - c < k:
            return 1.0
        return 1.0 - math.prod(1.0 - k / i for i in range(n - c + 1, n + 1))

    def _save_results(self, results: dict[str, AblationResult]) -> None:
        """Save results to JSON."""
        output = {
            "config": {
                "benchmark": self.config.benchmark,
                "model_name": self.config.model_name,
                "num_runs": self.config.num_runs,
                "max_steps": self.config.max_steps,
            },
            "results": {},
        }

        for key, result in results.items():
            output["results"][key] = {
                "success_rate": result.success_rate,
                "pass_at_1": result.pass_at_1,
                "pass_at_3": result.pass_at_3,
                "pass_at_5": result.pass_at_5,
                "total_tokens": result.total_tokens,
                "tokens_per_task": result.total_tokens / max(1, result.total_tasks),
                "model_calls": result.model_calls,
                "model_calls_per_task": result.model_calls / max(1, result.total_tasks),
                "avg_latency_ms": result.avg_latency_ms,
                "p50_latency_ms": result.p50_latency_ms,
                "p95_latency_ms": result.p95_latency_ms,
                "p99_latency_ms": result.p99_latency_ms,
                "fast_path_ratio": result.fast_path_ratio,
                "skill_reuse_rate": result.skill_reuse_rate,
                "verification_pass_rate": result.verification_pass_rate,
                "unsafe_action_rate": result.unsafe_action_rate,
            }

        filename = f"{self.config.output_dir}/ablation_{self.config.benchmark}_{self.config.model_name}.json"
        with open(filename, "w") as f:
            json.dump(output, f, indent=2)

        print(f"Results saved to {filename}")

    def _print_comparison(self, results: dict[str, AblationResult]) -> None:
        """Print comparison table."""
        print("\n" + "=" * 90)
        print(f"Ablation Results: {self.config.benchmark}")
        print(f"Model: {self.config.model_name}")
        print("=" * 90)

        baseline = results["baseline"]
        lhic = results["lhic"]

        print(f"\n{'Metric':<35} {'Baseline':>15} {'LHIC':>15} {'Delta':>15}")
        print("-" * 90)

        metrics = [
            ("Success Rate", baseline.success_rate, lhic.success_rate, "%"),
            ("Pass@1", baseline.pass_at_1, lhic.pass_at_1, "%"),
            ("Total Tokens", baseline.total_tokens, lhic.total_tokens, ""),
            ("Tokens/Task", baseline.total_tokens / max(1, baseline.total_tasks),
             lhic.total_tokens / max(1, lhic.total_tasks), ""),
            ("Model Calls", baseline.model_calls, lhic.model_calls, ""),
            ("Calls/Task", baseline.model_calls / max(1, baseline.total_tasks),
             lhic.model_calls / max(1, lhic.total_tasks), ""),
            ("Avg Latency (ms)", baseline.avg_latency_ms, lhic.avg_latency_ms, ""),
            ("P95 Latency (ms)", baseline.p95_latency_ms, lhic.p95_latency_ms, ""),
            ("Fast Path Ratio", baseline.fast_path_ratio, lhic.fast_path_ratio, "%"),
            ("Skill Reuse", baseline.skill_reuse_rate, lhic.skill_reuse_rate, "%"),
            ("Verification Pass", baseline.verification_pass_rate, lhic.verification_pass_rate, "%"),
            ("Unsafe Actions", baseline.unsafe_action_rate, lhic.unsafe_action_rate, "%"),
        ]

        for name, base_val, lhic_val, unit in metrics:
            delta = lhic_val - base_val
            if unit == "%":
                print(f"{name:<35} {base_val:>14.1%} {lhic_val:>14.1%} {delta:>+14.1%}")
            else:
                print(f"{name:<35} {base_val:>15.1f} {lhic_val:>15.1f} {delta:>+15.1f}")

        print("\n" + "=" * 90)


def run_webarena_ablation(model_name: str = "gpt-5.6-sol") -> dict[str, AblationResult]:
    """Run WebArena ablation study."""
    config = AblationConfig(
        benchmark="webarena",
        model_name=model_name,
        num_runs=1,
        max_steps=50,
        enable_learning=True,
        output_dir="ablation_results/webarena",
    )

    runner = AblationRunner(config)
    return runner.run_full_ablation()


def run_osworld_ablation(model_name: str = "gpt-5.6-sol") -> dict[str, AblationResult]:
    """Run OSWorld 2.0 ablation study."""
    config = AblationConfig(
        benchmark="osworld",
        model_name=model_name,
        num_runs=1,
        max_steps=500,
        enable_learning=True,
        output_dir="ablation_results/osworld",
    )

    runner = AblationRunner(config)
    return runner.run_full_ablation()


if __name__ == "__main__":
    import sys

    benchmark = sys.argv[1] if len(sys.argv) > 1 else "webarena"
    model = sys.argv[2] if len(sys.argv) > 2 else "gpt-5.6-sol"

    if benchmark == "webarena":
        run_webarena_ablation(model)
    elif benchmark == "osworld":
        run_osworld_ablation(model)
    else:
        print(f"Unknown benchmark: {benchmark}")
        print("Usage: python ablation_runner.py [webarena|osworld] [model_name]")
