# Internal benchmark

`tests/fixtures/internal-benchmark.json` contains 10 local fixtures each for `fill_form`, `download_file`, `login`, `search`, and `test_web_flow`.

This is a deterministic regression/smoke suite, not a market benchmark. Its results must not be described as SOTA.

Run the local benchmark with:

```bash
npm run bench:internal
```

It executes local Playwright pages and reports task success rate, median/P95 completion time, model calls per task, Fast Path ratio, structured/raw-coordinate action ratios, verifier pass rate, false-positive success rate, and human intervention count.

The current acceptance thresholds are task success rate ≥ 85%, median model calls per task ≤ 2, Fast Path ratio ≥ 70%, and verifier pass rate ≥ 90%.

For an externally comparable evaluation and the evidence required before any performance claim, follow [the external benchmark protocol](../benchmarks/README.md).

For a controlled selector-resilience ablation, see [the advantage simulation](advantage-simulation.md). It is deliberately not an external market comparison.
