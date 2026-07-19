# Internal benchmark

`tests/fixtures/internal-benchmark.json` contains 10 local fixtures each for
`browser_plan`, `fill_form`, `download_file`, `login`, `search`, and
`test_web_flow`. The `browser_plan` fixture is a four-step daily workflow that
searches, fills an update, and saves it with post-action verifiers.

This is a deterministic regression/smoke suite, not a market benchmark. Its results must not be described as SOTA.

Run the local benchmark with:

```bash
npm run bench:internal
```

It executes five local Playwright repetitions and reports task success rate, median/P95 completion time, model calls per task, Fast Path ratio, structured/raw-coordinate action ratios, verifier pass rate, false-positive success rate, and human intervention count. The median P95 becomes the same-machine baseline; every repetition must remain within 10% of it.

The current acceptance thresholds are task success rate ≥ 85%, model and MCP
planner calls per Fast Path task = 0, Fast Path ratio ≥ 70%, and verifier pass
rate ≥ 90%. The daily browser workflow additionally requires controlled p95
completion at or below five seconds and verifier pass rate ≥ 90%.

For an externally comparable evaluation and the evidence required before any performance claim, follow [the external benchmark protocol](../benchmarks/README.md).

For a controlled selector-resilience ablation, see [the advantage simulation](advantage-simulation.md). It is deliberately not an external market comparison.
