# LHIC Benchmark Methodology

## Overview

This document describes the methodology for evaluating LHIC (Local Human Intent Controller) against standard computer-use benchmarks.

## Internal Benchmark Results

### Test Configuration

- **Tasks**: 60 (10 per skill × 6 skills)
- **Repetitions**: 5
- **Environment**: Headless Chromium, Node.js 22, Playwright

### Results Summary

<!-- prettier-ignore -->
| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| Task Success Rate | **100%** | ≥95% | ✅ PASS |
| Fast Path Ratio | **100%** | ≥90% | ✅ PASS |
| Verifier Pass Rate | **100%** | ≥95% | ✅ PASS |
| Model Calls per Task | **0** | ≤1 | ✅ PASS |
| Median Latency | **180ms** | ≤500ms | ✅ PASS |
| P95 Latency | **968ms** | ≤2000ms | ✅ PASS |
| False Positive Rate | **0%** | ≤5% | ✅ PASS |
| Human Interventions | **0** | ≤1 | ✅ PASS |

### Key Findings

1. **Zero LLM Calls**: All 60 tasks completed without any model invocations
2. **100% Verification**: Every task produced verifier evidence
3. **Sub-second Latency**: Median 180ms, P95 968ms
4. **No False Positives**: All success determinations were accurate

## External Benchmark Preparation

### WebArena (812 tasks)

- **Status**: Adapter and preflight coverage are available; no official evaluator result has been collected.
- **Requirements**: Pinned AgentLab/WebArena environment, reachable benchmark services, model credentials, and submission authorization.

### OSWorld (369 tasks)

- **Status**: Adapter and preflight coverage are available; no official evaluator result has been collected.
- **Requirements**: Pinned OSWorld checkout, VM provider/image, model credentials, and submission authorization.

## Unique Differentiators

### 1. One-shot Learning

- Learn from single successful execution
- No 3-run holdout requirement for low-risk actions
- Immediate skill capture and reuse

### 2. Parallel Execution

- Independent actions execute concurrently
- Up to 5x speed improvement
- Smart dependency analysis

### 3. Failure Learning

- Learn from failures to avoid repeating mistakes
- Predict failure likelihood before execution
- Suggest workarounds for common failures

### 4. Unified Browser + Desktop

- Single API for browser and desktop automation
- Cross-platform support (macOS, Windows, Linux)
- Accessibility tree reading for desktop apps

### 5. Skill Composition

- Combine simple skills into complex workflows
- Automatic skill chaining
- Precondition/postcondition validation

### 6. Incremental & Transfer Learning

- Update skills without re-learning from scratch
- Transfer skills across similar sites
- Online learning during execution

### 7. Prefetching & Streaming

- Pre-load skills likely to be needed
- Start execution before full planning
- Adaptive confidence thresholds

### 8. Retry & Circuit Breaker

- Exponential backoff with jitter
- Circuit breaker for cascading failures
- Timeout protection for all operations

## External Benchmark Status

The WebArena, OSWorld, and $\tau$-bench adapters are readiness infrastructure.
Preflight success, LHIC receipts, and internal benchmark results are not official
external evaluator results and must not be reported as such.

## Artifacts

### Code Artifacts

- Source code: `/root/lhic`
- Build output: `/root/lhic/dist`
- Test results: `/root/lhic/test-results`

### Benchmark Artifacts

- Internal benchmark report: `/root/lhic/benchmark-report.json`
- Trace logs: `/root/lhic/.lhic/traces`
- Screenshots: `/root/lhic/.lhic/screenshots`

### Documentation

- Architecture: `/root/lhic/docs/architecture.md`
- Security: `/root/lhic/docs/security.md`
- Quickstart: `/root/lhic/docs/quickstart.md`

## Reproduction Instructions

### Prerequisites

- Node.js 22+ (24 recommended)
- Playwright Chromium
- macOS, Windows, or Linux

### Steps

1. Clone repository
2. Install dependencies: `npm ci`
3. Build: `npm run build`
4. Run internal benchmark: `npm run bench:internal`
5. Verify results: `npm test`

### Expected Output

```json
{
  "passed": true,
  "fastOnlyBaselineP95Ms": 968,
  "passCriteria": {
    "taskSuccessRate": true,
    "fastPathRatio": true,
    "verifierPassRate": true
  }
}
```

## Submission Checklist

- [x] Internal benchmark passing
- [x] All tests passing
- [x] Build successful
- [x] Documentation complete
- [ ] WebArena benchmark run
- [ ] OSWorld benchmark run
- [ ] Comparator analysis
- [ ] Independent reproduction
- [ ] Human submission authorization

## Contact

For benchmark inquiries, please refer to the project repository.
