"""Static compatibility check for the pinned OSWorld 2.0 runner source.

This does not execute OSWorld or its evaluator. It verifies that the pinned
release still exposes the planner -> action loop -> env.step boundary assumed by
LHIC's thin runner interposition.
"""

from __future__ import annotations

import ast
import pathlib
import sys


def call_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Attribute):
        parts = [func.attr]
        value = func.value
        while isinstance(value, ast.Attribute):
            parts.append(value.attr)
            value = value.value
        if isinstance(value, ast.Name):
            parts.append(value.id)
        return ".".join(reversed(parts))
    if isinstance(func, ast.Name):
        return func.id
    return None


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check_pinned_contract.py <OSWorld-V2 checkout>", file=sys.stderr)
        return 2

    root = pathlib.Path(sys.argv[1]).resolve()
    runner = root / "lib_run_single.py"
    if not runner.exists():
        print(f"missing pinned runner: {runner}", file=sys.stderr)
        return 1

    source = runner.read_text(encoding="utf-8")
    tree = ast.parse(source, filename=str(runner))
    predict_calls = []
    env_step_calls = []

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = call_name(node)
        if name and name.endswith(".predict"):
            predict_calls.append(node.lineno)
        if name == "env.step":
            env_step_calls.append(node.lineno)

    errors = []
    if not predict_calls:
        errors.append("no agent .predict(...) call found in lib_run_single.py")
    if not env_step_calls:
        errors.append("no env.step(...) call found in lib_run_single.py")
    if "sleep_after_execution" not in source:
        errors.append("runner no longer references sleep_after_execution")
    if not any(predict < step for predict in predict_calls for step in env_step_calls):
        errors.append("no planner predict call appears before an env.step call")

    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(
        "OSWorld pinned runner contract OK: "
        f"predict calls={len(predict_calls)}, env.step calls={len(env_step_calls)}, "
        f"runner={runner}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
