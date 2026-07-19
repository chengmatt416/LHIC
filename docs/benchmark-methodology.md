# Benchmark methodology

## Question

Does LHIC's local deterministic Fast Path execute its supported browser skills
with verifier evidence on controlled fixtures, without model calls or raw
coordinate actions?

## Fixture and baseline

`tests/fixtures/internal-benchmark.json` contains ten local fixtures for each
of `browser_plan`, `fill_form`, `download_file`, `login`, `search`, and
`test_web_flow`. `browser_plan` executes a four-step search, form-fill, and
save workflow with post-action verifiers.
`apps/cli/src/internal-benchmark.ts` runs them in headless Playwright Chromium.
There is no external website, customer data, remote model call, or competitor
comparison in this benchmark.

The selector-resilience simulation compares semantic targeting only with an
intentionally limited fixed-selector ablation. It is an engineering signal, not
a general claim about browser automation agents.

## Reproduce

```bash
npm run bench:internal
npm run bench:simulate
# Save the per-fixture raw results without overwriting an existing artifact:
npm run bench:internal -- --output artifacts/internal-benchmark.json
```

The report includes task success rate, median and P95 completion time, model
calls per task, MCP calls per task, Fast Path ratio, structured-action ratio, raw-coordinate-action
ratio, verifier pass rate, false-positive success rate, and human-intervention
count. It also reports dedicated success, verifier, and p95 latency metrics for
the multi-step daily browser workflow. Record the command output, machine, OS, Node, Playwright, browser
revision, repetition count, and commit SHA whenever publishing a result.

For a multi-path release, `npm run bench:internal` captures five runs and uses
their median P95 as the same-machine Fast Path baseline. Every run must remain
within 10% of that baseline. `fast_only` must retain zero model and MCP planner
calls, verifier evidence for every successful fixture, and the resulting P95
gate. Report Slow Path calls,
input size, and image count separately for `balanced` and `deliberative`; do
not blend those costs into Fast Path claims.

## Limits

The current internal benchmark is a deterministic regression suite. It does
not establish real-world success, cost, security, or benchmark leadership. An
external comparison requires the pinned, full-suite protocol in
[`benchmarks/README.md`](../benchmarks/README.md) and the submission gate in
[`market-research.md`](market-research.md).
