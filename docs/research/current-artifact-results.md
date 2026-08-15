# Current Artifact Results

These results are **artifact-validation and controlled integration results**, not external benchmark claims.

## Validated implementation

- Branch: `research/lhic-core-academic`
- Randomized campaign implementation commit: `33dd603125d8e2a1a62455f855ba7adf87e6e327`
- Real Failure Injection workflow run: `31880913272`
- Evidence artifact: `9246004589`
- Evidence digest: `sha256:e2c047a01fc5ba70ec909edf47ef25e0a0e6c2b52e82d21ec2b03ecd7abe4f79`
- Environment: Ubuntu 24.04 / Linux x64 / Node.js 22
- Flagship real-surface trials: 30
- Expanded semantic matrix: 5 cases
- Randomized cross-surface trials: 108 across two timing seeds

The workflow contains hard acceptance gates. It fails if a flagship baseline trial does not demonstrate the intended duplicate, if LHIC produces a duplicate side effect, if the expected durable state is not reached, or if the randomized campaign violates a mode-specific dispatch/recovery invariant.

## Core invariant and kernel tests

The academic artifact has thirteen Node.js tests:

1. planner cannot lower independently inferred risk;
2. high-risk action cannot use reusable origin scope;
3. verification requires independent non-empty evidence;
4. ambiguous side effect is not blindly retried;
5. verified action identity cannot be dispatched again;
6. trusted skill promotion requires three independent verified task IDs;
7. lost response after an external effect is recovered without a second dispatch;
8. verified action identity remains terminal across later runs;
9. pre-dispatch ambiguity with absent effect does not auto-dispatch;
10. delayed visibility can verify later without duplicate dispatch;
11. repeated inconclusive observations remain `needs_resolution` and non-dispatchable;
12. duplicate action delivery after verification is blocked without a second dispatch;
13. workspace conflict during recovery prevents verified completion without replay.

The Academic Artifact workflow also validates the OSWorld 2.0 runner-interposition scaffold with Python unit tests.

## 1. Flagship real-surface failure injection

Injected failure:

```text
persist possibly_committed
        -> dispatch real external action
        -> external effect commits
        -> dispatcher process is SIGKILLed
        -> agent receives no completion response
        -> restart from durable ledger
        -> observe external state
        -> verify postcondition
        -> do not replay
```

### Current 30-trial result

| Surface | Trials | Blind-retry duplicate effects | LHIC-Core duplicate effects | Verified recovery |
|---|---:|---:|---:|---:|
| Browser / Chromium | 10 | 10 | 0 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 | 0 | 10 / 10 |
| Code / Git | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Every accepted LHIC trial has one physical dispatch and one committed effect. The blind-retry baseline commits the same logical effect twice.

An earlier fresh GitHub Actions rerun of the same 30-trial flagship experiment reproduced the same aggregate outcome, giving 60 controlled flagship executions across those two attempts: 60 baseline duplicate effects, 0 LHIC duplicate effects, and 60 verified LHIC recoveries. This is runner repeatability evidence, not 60 independent open-world tasks.

## 2. Expanded five-case semantic matrix

| Case | Durable result | Dispatches | Observations | Verifications | Side effects | Duplicates | Result |
|---|---|---:|---:|---:|---:|---:|---|
| Pre-dispatch crash | `needs_resolution` | 1 | 1 | 0 | 0 | 0 | PASS |
| Delayed visibility | `verified` | 1 | 2 | 1 | 1 | 0 | PASS |
| Persistent inconclusive observation | `needs_resolution` | 1 | 1 | 0 | 1 | 0 | PASS |
| Duplicate delivery | durable `verified` | 1 | 0 | 1 | 1 | 0 | PASS |
| Workspace conflict | `executed` / unverified | 1 | 1 | 1 | 1 | 0 | PASS |

The delayed-visibility case is important because the first recovery can enter `needs_resolution` and a later invocation must re-observe rather than re-dispatch.

## 3. Seeded randomized cross-surface campaign

The randomized layer runs the same six fault semantics on real Chromium, X11/Tk, and Git surfaces. Timing is derived from a deterministic seed so the experiment varies while remaining reproducible.

Each seed executes:

```text
3 surfaces x 6 fault modes x 3 trials = 54 trials
```

Two independent timing seeds were used:

- `2026-08-15`
- `2026-08-16`

### Aggregate result

| Seed | Trials | Passed | Failed | Duplicate side effects |
|---|---:|---:|---:|---:|
| `2026-08-15` | 54 | 54 | 0 | 0 |
| `2026-08-16` | 54 | 54 | 0 | 0 |
| **Combined** | **108** | **108** | **0** | **0** |

### Mode results across both seeds

| Fault mode | Trials | Expected durable behavior | Result |
|---|---:|---|---|
| Pre-dispatch failure | 18 | `needs_resolution`, no auto-replay | 18 / 18 |
| Post-commit lost response | 18 | recover to `verified` | 18 / 18 |
| Delayed visibility | 18 | repeated re-observation, then `verified` | 18 / 18 |
| Partial postcondition | 18 | `executed` / unverified, no replay | 18 / 18 |
| Duplicate delivery | 18 | verified identity blocks second dispatch | 18 / 18 |
| Late completion after recovery | 18 | verified identity remains terminal | 18 / 18 |

Injected visibility delays ranged from **41 ms to 220 ms**. Delayed-visibility trials required **2 to 6 recovery observations** before the external effect became visible and verifiable, while the physical dispatch count remained one.

### Diagnostic harness latency

These are controlled harness timings, not optimized LHIC overhead measurements.

| Surface | Randomized trials | Mean case latency | Median case latency |
|---|---:|---:|---:|
| Browser / Chromium | 36 | ~302 ms | 289 ms |
| Desktop / X11 + Tk | 36 | ~199 ms | 196 ms |
| Code / Git | 36 | ~43 ms | 21 ms |

The delayed-visibility mode ranged from 120–496 ms because wait time is intentionally injected. A paired no-fault overhead experiment is still required before making a runtime-cost claim.

## Real surface details

### Browser

The browser experiments use a real local HTTP service and Chromium through Playwright. External actions are actual form submissions. The DOM exposes committed count and postcondition state, while screenshot bytes are hashed into verifier evidence.

### Desktop

The desktop experiments run a real Tk window in Xvfb and deliver an X11 pointer action using `xdotool`. The native window title exposes the persisted committed count and `status=complete|partial`, so a committed effect can be distinguished from a complete postcondition.

### Code

The code experiments create isolated real Git repositories. External actions create real files and commits. Complete cases include a required postcondition file; partial cases intentionally omit it. Recovery inspects file content and Git history.

## Deterministic synthetic failure injection

The synthetic harness remains a fast semantic regression suite. It runs 100 deterministic trials per strategy over five modeled failure modes.

| Strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

Synthetic and real-surface results serve different purposes. The simulator provides fast ablation coverage; the real-surface suite verifies that the protocol survives real process boundaries and external state changes.

## OSWorld 2.0 adapter status

`adapters/osworld-v2/` now contains the first external-validity scaffold. It is designed to interpose between planner action output and OSWorld's official `env.step(...)` call while leaving task setup, step budget, environment, and evaluator unchanged.

The current scaffold validates two ordering properties:

1. durable-boundary `before_dispatch` is invoked before `env.step`;
2. an exception/timeout is reported as a lost response and is not converted into a synthetic retry.

This is an adapter contract test, not an OSWorld score. A real LHIC bridge and pinned OSWorld environment run remain future work.

## Interpretation and claim boundary

The controlled evidence supports the following narrow statement:

> In the validated controlled fixtures, LHIC-Core prevented duplicate replay in the flagship post-commit crash experiment and matched the expected durable execution state in 108/108 additional seeded browser, desktop, and code trials spanning pre-dispatch failure, lost completion, delayed visibility, partial postconditions, duplicate delivery, and late completion after recovery. No randomized trial produced a duplicate side effect.

This does **not** establish general computer-use capability, higher planner accuracy, statistical superiority over agents on an open-world task distribution, or SOTA performance on OSWorld, SWE-bench, tau-bench, or other official benchmarks.

## Next evaluation layer

1. connect the OSWorld 2.0 scaffold to the TypeScript LHIC kernel;
2. run a pinned OSWorld 2.0 release without changing official evaluator scoring;
3. add paired no-fault overhead measurements for ledger persistence, observations, and verification;
4. add larger same-repository concurrent code mutations;
5. build a coding-benchmark adapter that preserves official patch extraction and evaluation.
