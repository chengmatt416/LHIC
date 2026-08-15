# Randomized Cross-Surface Failure Campaign

This experiment is the third controlled evaluation layer for LHIC-Core. It keeps the execution kernel fixed while varying failure timing and observation behavior over **real browser, desktop, and code surfaces**.

The campaign is an artifact-validation experiment, not an official OSWorld, SWE-bench, or other benchmark score.

## Validated run

- Implementation commit: `33dd603125d8e2a1a62455f855ba7adf87e6e327`
- GitHub Actions workflow: `Real Failure Injection`
- Workflow run: `31880913272`
- Evidence artifact: `9246004589`
- Artifact digest: `sha256:e2c047a01fc5ba70ec909edf47ef25e0a0e6c2b52e82d21ec2b03ecd7abe4f79`
- Environment: Ubuntu 24.04, Linux x64, Node.js 22
- Real surfaces: Chromium/HTTP, X11/Tk/xdotool, isolated Git repositories

## Experimental design

The campaign uses a deterministic seeded schedule so that timing varies while remaining reproducible. Each seed runs:

```text
3 surfaces x 6 fault modes x 3 trials = 54 trials
```

Two independent timing seeds were executed:

- seed A: `2026-08-15`
- seed B: `2026-08-16`

Total randomized trials: **108**.

For each surface/mode/trial tuple, a seed-derived schedule chooses a visibility delay and polling interval. Across the validated two-seed run, injected visibility delays ranged from **41 ms to 220 ms**.

## Failure modes

1. `pre_dispatch_failure`
   - LHIC persists ambiguity, then the injected failure occurs before the physical external action.
   - Recovery observes absence and keeps the action at `needs_resolution` rather than automatically replaying it.

2. `post_commit_lost_response`
   - The real external effect commits, but the completion signal is lost.
   - Recovery re-observes the real surface, verifies the postcondition, and reaches `verified` without replay.

3. `delayed_visibility`
   - The external effect commits, but recovery observations remain inconclusive until a seed-derived visibility delay expires.
   - The kernel repeatedly re-observes from `needs_resolution`; it never re-dispatches the action.

4. `partial_postcondition`
   - A real side effect occurs but the full postcondition is intentionally incomplete.
   - Observation sees the effect, verification fails, and the action remains `executed`/unverified without replay.

5. `duplicate_delivery`
   - The first execution completes and verifies normally, then the same logical action identity is delivered again.
   - The durable `verified` identity blocks a second dispatch.

6. `late_completion_after_recovery`
   - The initial completion is lost, recovery independently verifies the committed effect, and the same logical action is later delivered again as a stale/late completion path.
   - The verified ledger identity remains terminal and prevents duplicate execution.

## Real surface definitions

### Browser

A real Chromium instance controlled by Playwright submits an HTML form to a local HTTP server. The committed counter and postcondition status are observed from the DOM; screenshot bytes are hashed into verifier evidence.

### Desktop

A real Tk application runs under Xvfb. `xdotool` delivers an X11 pointer click to the visible button. The native window title exposes the persisted committed count and `status=complete|partial`, allowing the verifier to distinguish a committed effect from a complete postcondition.

### Code

Each trial creates an isolated real Git repository. The external action writes a feature marker and commits it. Complete cases also write a required postcondition file; partial-postcondition cases deliberately omit that file. Recovery inspects file content and Git history.

## Results

### Aggregate

| Seed | Trials | Passed | Failed | Duplicate side effects |
|---|---:|---:|---:|---:|
| `2026-08-15` | 54 | 54 | 0 | 0 |
| `2026-08-16` | 54 | 54 | 0 | 0 |
| **Combined** | **108** | **108** | **0** | **0** |

Every accepted randomized trial dispatched its logical action at most once.

### Final durable states by fault mode

| Fault mode | Trials across two seeds | Expected durable state | Observed result |
|---|---:|---|---|
| Pre-dispatch failure | 18 | `needs_resolution` | 18/18 |
| Post-commit lost response | 18 | `verified` | 18/18 |
| Delayed visibility | 18 | `verified` after re-observation | 18/18 |
| Partial postcondition | 18 | `executed` / unverified | 18/18 |
| Duplicate delivery | 18 | durable `verified`, no redispatch | 18/18 |
| Late completion after recovery | 18 | durable `verified`, no redispatch | 18/18 |

### Delayed visibility behavior

The delayed-visibility cases did not collapse to a fixed number of polls. Across both seeds and all surfaces, they required **2 to 6 recovery observations** before the effect became visible and verifiable. This is important because it exercises repeated entry into `needs_resolution` without permitting a second dispatch.

### Harness latency

These timings are diagnostic harness measurements, not optimized performance claims.

Across the combined 108 randomized trials:

| Surface | Trials | Mean case latency | Median case latency |
|---|---:|---:|---:|
| Browser / Chromium | 36 | ~302 ms | 289 ms |
| Desktop / X11 + Tk | 36 | ~199 ms | 196 ms |
| Code / Git | 36 | ~43 ms | 21 ms |

Mode-level ranges include:

- delayed visibility: 120–496 ms;
- pre-dispatch failure: 2–108 ms;
- post-commit lost response: 19–308 ms;
- partial postcondition: 24–442 ms.

Because the campaign intentionally injects wait time, these values should not be interpreted as LHIC runtime overhead. A separate no-fault paired overhead experiment is still required.

## What this adds beyond the flagship experiment

The original real-surface suite isolates one failure window: external commit followed by dispatcher crash before the agent receives completion. The randomized campaign broadens internal validity in three ways:

1. it varies timing rather than repeating one fixed schedule;
2. it checks fail-closed behavior when the effect is absent or only partially satisfies the postcondition;
3. it checks replay exclusion under duplicate and late logical delivery.

The two seeds are different fault schedules, but they still use controlled fixtures. They are not independent samples from an open-world task distribution.

## Claim boundary

The defensible claim from this campaign is narrow:

> Across 108 seeded controlled trials over real Chromium, X11/Tk, and Git surfaces, six non-atomic execution variants produced zero duplicate side effects and matched the expected durable LHIC-Core state in every trial. Delayed-visibility cases required between two and six recovery observations while retaining a single dispatch.

This does not establish general computer-use capability, planner quality, or benchmark SOTA. External validity requires wrapping official benchmark runners without changing their task setup or evaluator scoring.

## Next step

The next layer is an official-benchmark adapter. The first target is OSWorld 2.0 using a pinned supported release. LHIC should be inserted **between planner action output and `env.step(...)`**, while the official OSWorld evaluator remains unchanged. The adapter must keep execution-semantic metrics separate from official task scores.
