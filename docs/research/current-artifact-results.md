# Current Artifact Results

These results are **artifact-validation and controlled integration results**, not external benchmark claims.

## Validated implementation and evidence

### Real-surface fault campaign

- implementation commit: `dccaf0505aa79850687e10516336b746a69515bc`
- workflow: `Real Failure Injection`
- workflow run: `31881515462`
- evidence artifact: `9246160051`
- artifact digest: `sha256:7b5a84577f848d3f01809196b69aeb48c9b4c455d38cef6d0934db3c3b957872`
- environment: Ubuntu 24.04 / Linux x64 / Node.js 22

The exact implementation passed the flagship real-surface suite, the five-case semantic matrix, and both randomized timing seeds.

### Core / adapter / overhead validation

- split-boundary implementation commit: `dccaf0505aa79850687e10516336b746a69515bc`
- `Academic Artifact` run: `31881515546` — success
- overhead evidence artifact: `9246140145`
- overhead artifact digest: `sha256:70f16517cc9d9a447c29d6bcd2c294aabcb14b53bdea4ea6ef5c609af6d86690`
- pinned-upstream OSWorld contract run: `31881642593` — success

The academic workflow validates TypeScript invariants/integration tests, the synthetic ablation harness, the paired no-fault microbenchmark, Python runner-boundary tests, the live Python→Node→TypeScript durable bridge, and the pinned OSWorld upstream runner contract.

## 1. Executable tests

The academic artifact currently has **16 Node.js tests**:

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
13. workspace conflict during recovery prevents verified completion without replay;
14. split boundary durably persists `possibly_committed` before permitting external dispatch;
15. executor response reaches only `executed`, not self-certified `verified`;
16. lost-response state can survive and recover to `verified` without re-dispatch.

In addition, Python adapter tests verify benchmark-side call ordering and the cross-language bridge.

## 2. Flagship real-surface failure injection

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

### Result

| Surface | Trials | Blind-retry duplicate effects | LHIC-Core duplicate effects | Verified recovery |
|---|---:|---:|---:|---:|
| Browser / Chromium | 10 | 10 | 0 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 | 0 | 10 / 10 |
| Code / Git | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Every accepted LHIC flagship trial physically dispatches once and commits one side effect. The blind-retry baseline commits the same logical effect twice.

An earlier fresh GitHub Actions rerun reproduced the same aggregate flagship result. That is runner-repeatability evidence, not 60 independent open-world tasks.

## 3. Expanded five-case semantic matrix

| Case | Durable result | Dispatches | Observations | Verifications | Side effects | Duplicates | Result |
|---|---|---:|---:|---:|---:|---:|---|
| Pre-dispatch crash | `needs_resolution` | 1 | 1 | 0 | 0 | 0 | PASS |
| Delayed visibility | `verified` | 1 | 2 | 1 | 1 | 0 | PASS |
| Persistent inconclusive | `needs_resolution` | 1 | 1 | 0 | 1 | 0 | PASS |
| Duplicate delivery | durable `verified` | 1 | 0 | 1 | 1 | 0 | PASS |
| Workspace conflict | `executed` / unverified | 1 | 1 | 1 | 1 | 0 | PASS |

This layer established an important kernel rule: `needs_resolution` remains part of the ambiguity-recovery state set. A later invocation must re-observe rather than fall through to normal physical dispatch.

## 4. Seeded randomized cross-surface campaign

The randomized layer exercises six fault semantics on real Chromium, X11/Tk, and Git surfaces. A deterministic seed varies visibility delay and polling schedule while preserving reproducibility.

Each timing seed executes:

```text
3 surfaces x 6 fault modes x 3 trials = 54 trials
```

Seeds:

- `2026-08-15`
- `2026-08-16`

### Aggregate result

| Seed | Trials | Passed | Failed | Duplicate side effects |
|---|---:|---:|---:|---:|
| `2026-08-15` | 54 | 54 | 0 | 0 |
| `2026-08-16` | 54 | 54 | 0 | 0 |
| **Combined** | **108** | **108** | **0** | **0** |

### Mode results

| Fault mode | Trials | Expected durable behavior | Result |
|---|---:|---|---|
| Pre-dispatch failure | 18 | `needs_resolution`, no automatic replay | 18 / 18 |
| Post-commit lost response | 18 | recover to `verified` | 18 / 18 |
| Delayed visibility | 18 | repeated re-observation, then `verified` | 18 / 18 |
| Partial postcondition | 18 | `executed` / unverified, no replay | 18 / 18 |
| Duplicate delivery | 18 | verified identity blocks second dispatch | 18 / 18 |
| Late completion after recovery | 18 | verified identity remains terminal | 18 / 18 |

Injected visibility delays span **41–220 ms**. Delayed-visibility trials require **2–6 recovery observations** before the effect becomes visible and independently verifiable, while physical dispatch remains exactly one.

## 5. Real surface definitions

### Browser

A real Chromium process submits forms to a local HTTP service. The DOM exposes committed count and postcondition state; screenshot bytes can be hashed into verifier evidence.

### Desktop

A real Tk window runs inside Xvfb. `xdotool` delivers an X11 mouse click. Native window state exposes the persisted committed count and `status=complete|partial`, allowing the verifier to separate “an effect happened” from “the requested postcondition is complete.”

### Code

Each controlled trial uses an isolated real Git repository. The action performs real writes and commits. Complete cases include a required postcondition file; partial cases intentionally omit it. Recovery inspects file state and Git history.

## 6. Paired no-fault reference-artifact overhead

The microbenchmark uses 80 interleaved trials per variant on a local code-side marker action. One warm-up per variant is excluded.

| Variant | Mean | Median | p95 |
|---|---:|---:|---:|
| Direct execute | 0.258 ms | 0.182 ms | 0.291 ms |
| Direct execute + read-back verification | 0.406 ms | 0.367 ms | 0.553 ms |
| Split durable boundary | 1.494 ms | 1.506 ms | 1.777 ms |
| Full LHIC-Core | 2.157 ms | 2.108 ms | 2.667 ms |

Median differences:

```text
split boundary - direct execute       = +1.324 ms
full kernel - direct execute + verify = +1.741 ms
```

These are **academic atomic-JSON reference-artifact** numbers. They are not product SQLite latency, browser latency, remote API latency, or an OSWorld overhead claim. The direct operation is sub-millisecond, so the raw ~11.6x full-kernel/direct ratio is especially inappropriate as a production characterization.

See `docs/research/no-fault-overhead.md` for methodology and claim boundaries.

## 7. Synthetic ablation harness

The synthetic harness remains a fast semantic regression suite. It runs 100 deterministic trials per strategy over five modeled failure modes.

| Strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

Synthetic and real-surface results serve different purposes: the simulator provides cheap ablation coverage; the real fixtures establish that the execution protocol survives actual process boundaries and external state transitions.

## 8. Split-phase boundary for external runners

`src/boundary.ts` exposes a split-phase API so an official benchmark runner can retain control of its physical action call:

```text
prepare(action)
    -> policy / exact approval
    -> durable possibly_committed
    -> returns dispatchAllowed=true

external runner performs its own action

recordResponse(actionId)
    -> executed, NOT verified

recordLostResponse(actionId)
    -> preserves ambiguity

recover(actionId, observation, evidence)
    -> verified / executed / needs_resolution
```

This solves a practical integration problem: an official runner such as OSWorld can keep its own `env.step(...)` call and evaluator while LHIC owns durable execution semantics around that call.

## 9. OSWorld 2.0 adapter status

`adapters/osworld-v2/` now contains:

- a Python `execute_with_lhic_boundary(...)` wrapper around `env.step`;
- a persistent Python `NodeBoundaryClient`;
- a JSONL TypeScript bridge server backed by `SplitExecutionBoundary` and the durable ledger;
- cross-language restart/recovery tests;
- a pinned-upstream contract checker.

The cross-language test path is real:

```text
Python benchmark wrapper
        -> persistent Node subprocess
        -> TypeScript SplitExecutionBoundary
        -> FileSideEffectLedger
        -> durable JSON state
```

Validated properties include:

1. `possibly_committed` exists before the fake benchmark `env.step` is called;
2. successful executor return records only `executed`;
3. lost response remains `possibly_committed`;
4. ledger state survives bridge restart;
5. externally supplied verifier evidence can recover to `verified`;
6. adapter failure paths do not add a blind retry.

The Academic CI also checks out the pinned OSWorld `v2026.06.24` source and statically verifies that its runner still contains the planner/action/`env.step(...)` boundary assumed by this adapter.

This is **not yet an official OSWorld run**. A real OSWorld environment plus task execution and a benchmark-appropriate per-action verifier are still required.

## 10. Interpretation and claim boundary

The current controlled evidence supports the following statement:

> In validated controlled fixtures, LHIC-Core prevented duplicate replay in the flagship post-commit crash experiment and matched the expected durable state in 108/108 additional seeded browser, desktop, and code trials spanning six non-atomic execution variants, with zero duplicate side effects. A split-phase cross-language boundary also preserved pre-dispatch durability and restart recovery for an OSWorld-style external runner.

This does **not** establish:

- general computer-use capability;
- higher planner accuracy;
- open-world statistical superiority;
- official OSWorld, SWE-bench, or tau-bench performance;
- production latency or throughput.

## 11. Next evaluation layer

1. connect an OSWorld action observation/verifier to the live bridge and execute a pinned official task subset;
2. keep official OSWorld task score separate from LHIC execution metrics;
3. add paired no-fault overhead on the real browser/desktop/Git surfaces;
4. add larger same-repository concurrent code mutation campaigns;
5. build a coding-benchmark adapter that preserves official patch extraction and evaluator scoring.
