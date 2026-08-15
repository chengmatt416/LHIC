# LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents

> **Status:** pre-submission research draft. Controlled artifact results reported here are internal-validity experiments, not official benchmark or universal SOTA claims.

## Abstract

Autonomous agents increasingly act through browsers, desktop interfaces, coding workspaces, shell commands, and external services. These actions are not atomic with the agent's tool-call response: an external side effect may commit before the dispatcher fails, a completion may be lost after the world has changed, a postcondition may become visible only after a delay, or a stale logical completion may arrive after recovery has already succeeded. Conventional agent loops often collapse these cases into binary tool-call success/failure and retry after missing completion, creating duplicate side effects, false completion, unsafe replay, or ambiguous provenance.

We present **LHIC-Core**, a model-independent execution kernel that separates probabilistic planning from execution truth. A planner proposes actions, while LHIC-Core independently classifies risk, enforces bounded approval, persists `possibly_committed` state before external dispatch, observes the external world during recovery, verifies postconditions, records authority-separated receipts, and blocks replay while an action remains unresolved. The academic artifact extracts these mechanisms from the full LHIC product into a compact TypeScript reference implementation with executable invariants, synthetic ablations, real Chromium/X11/Git failure-injection experiments, a split-phase boundary for external runners, and an OSWorld-compatible cross-language bridge scaffold.

In a controlled post-commit/pre-response crash experiment over Chromium, X11/Tk, and Git, blind retry produced one duplicate side effect in every one of 30 trials, while LHIC-Core produced zero duplicates and recovered to `verified` in all 30. A five-case semantic matrix validates adjacent ambiguity states. A third seeded randomized campaign executed **108 additional real-surface trials** over six fault modes and two timing schedules; all 108 matched their expected durable state and produced zero duplicate side effects. Delayed-visibility trials required between two and six recovery observations while retaining exactly one physical dispatch. In an 80-trial-per-variant local no-fault microbenchmark of the academic JSON reference artifact, median latency was 0.182 ms for direct execution, 0.367 ms for direct execution plus read-back verification, 1.506 ms for a split durable boundary, and 2.108 ms for the full kernel. These measurements are artifact-scoped rather than production latency claims. The current adapter additionally validates a persistent Python→Node→TypeScript boundary against the pinned OSWorld 2.0 runner contract without modifying official evaluator semantics.

## 1. Introduction

Modern agent evaluations often emphasize planning quality: the model observes context, chooses a tool call, receives a result, and continues. This abstraction hides a systems problem. A tool-call return value is not identical to execution truth.

A browser form can submit before the automation process dies. A GUI click can persist state before an RPC returns. A Git commit can reach disk while the agent loses the completion frame. A remote service may accept a request but expose the resulting state only after an eventually consistent delay. A verifier may observe that some effect exists yet determine that the full requested postcondition is incomplete. A duplicate logical action may arrive after the original action has already been verified.

The retry decision is therefore epistemic rather than purely procedural. After dispatch, the runtime may no longer know whether replay is safe. Treating every missing response as “the effect did not happen” can duplicate purchases, messages, destructive writes, credential changes, or commits. Treating every accepted tool call as “verified success” can instead create false completion. A third problem appears when a model is allowed to self-describe risk or success and the execution framework treats that description as authority.

LHIC-Core asks a narrower question than whether a model is a better agent:

> **What deterministic execution substrate should exist underneath a probabilistic planner when real side effects are non-atomic and externally observable?**

The central thesis is:

> **Planning may be probabilistic; execution truth should be explicit, durable, authority-aware, and independently verifiable.**

The work contributes a compact execution contract combining five mechanisms:

1. durable side-effect ambiguity recorded before external dispatch;
2. observe-and-verify-before-replay recovery;
3. authority-separated, evidence-carrying action receipts;
4. independent risk classification with bounded approval scope;
5. evidence-gated trusted reuse of learned behavior.

The current evaluation deliberately holds planning sophistication outside the primary claim. The artifact studies whether the execution substrate can prevent duplicate replay and false verification under controlled failures.

## 2. Problem model

We model an agent that proposes actions against an external environment. The environment may expose side effects through a browser, desktop UI, local code workspace, shell, network control plane, or remote API.

The runtime must handle at least the following conditions:

1. failure after durable intent persistence but before physical dispatch;
2. failure after dispatch but before completion response;
3. delayed visibility of a committed effect;
4. partial or conflicting postcondition state;
5. duplicated logical action delivery;
6. late/stale completion after successful recovery;
7. planner-supplied risk understatement;
8. expired or over-broad approval;
9. stale learned state;
10. concurrent external workspace modification.

### 2.1 Why binary tool status is insufficient

A missing response is evidence about the communication path, not the external world. After a non-atomic dispatch, at least three states can be observationally compatible with “tool failed”:

- no external effect occurred;
- the intended effect occurred;
- an ambiguous, partial, or conflicting effect occurred.

The runtime must preserve this uncertainty instead of collapsing it into a single retryable failure.

### 2.2 Threat model

LHIC-Core does not require a malicious base model. It assumes only that model output, tool responses, observations, and learned state can be incomplete, stale, mistaken, delayed, or interrupted.

The planner is consequently not trusted to self-certify authorization, side-effect risk, execution success, postcondition verification, or evidence quality. The execution layer should fail closed when it lacks evidence about a potentially irreversible effect.

## 3. Design overview

### 3.1 Independent risk classification

The runtime independently infers a side-effect class from the action surface, tool, intent, target, and origin. The planner may supply a proposed class, but effective risk is monotone with respect to independent runtime inference: the planner may raise risk but may never lower it.

### 3.2 Bounded approval scopes

Approval is structured authority rather than a boolean flag. The reference model supports exact-action, plan-step, read-only task, and bounded origin/action-class scopes. High-risk actions cannot inherit broad reusable scopes. Approval can bind action hash, expiry, origin, class, and usage count.

### 3.3 Durable side-effect ledger

Before physical dispatch, LHIC-Core persists the action as `possibly_committed`. This ordering is the crash-consistency mechanism. If the process dies immediately after dispatch, durable state already records that the external world may have changed.

The reference state set is:

```text
{ proposed, approved, possibly_committed, executed,
  verified, failed, needs_resolution, rolled_back }
```

`verified` is terminal for an action identity. The same verified identity cannot be physically dispatched again.

### 3.4 Observe-and-verify-before-replay recovery

When the ledger contains unresolved ambiguity, the runtime re-observes the external world before any replay decision:

```text
effect present   -> verify the intended postcondition; do not replay
effect absent    -> retain explicit resolution state; retry requires separate policy admission
inconclusive     -> needs_resolution; do not replay
```

A critical refinement from the failure-matrix experiments is that `needs_resolution` is itself an unresolved recovery state. A later call must re-observe it; it is not a clean slate that can fall through to normal dispatch.

### 3.5 Authority-separated receipts

An action receipt decomposes “success” into explicit facts. It records action identity, risk class, approval authority, execution authority, verifier authority, ledger state, and evidence.

Executor success is not upgraded to verification unless an independent verifier emits passing, non-empty evidence. A replay-blocked call against a previously verified identity illustrates the distinction: the durable ledger remains terminally `verified`, while a new receipt with no new verifier evidence does not pretend a fresh verification occurred.

### 3.6 Trust-aware learned behavior

Reusable learned behavior is promoted only after multiple independent verified task identities plus holdout success, with code-anchor staleness checks where applicable. Repeating one task identity cannot manufacture independent evidence.

## 4. Formal execution model

The nominal success path is:

```text
proposed / approved
        -> possibly_committed     [persist before dispatch]
        -> executed               [completion observed]
        -> verified               [independent evidence]
```

The ambiguous recovery path is:

```text
possibly_committed / executed / needs_resolution
        -> observe external state
        -> verify if effect appears present
        -> verified | executed | needs_resolution
```

The paper-facing properties are:

- **P1 — no planner risk downgrade**;
- **P2 — high-risk scope narrowing**;
- **P3 — durable ambiguity before external dispatch**;
- **P4 — verified replay exclusion**;
- **P5 — execution is not verification**;
- **P6 — no blind replay from unresolved ambiguity**;
- **P7 — independent evidence before trusted reuse**.

The current artifact is an executable operational model, not a machine-checked proof.

## 5. Academic artifact

The research branch deliberately removes product shell code and exposes the protocol directly.

### 5.1 Reference kernel

- `src/model.ts` — actions, approvals, ledger entries, evidence, receipts, and memory;
- `src/policy.ts` — independent risk inference and monotonic effective risk;
- `src/approval.ts` — bounded approval semantics;
- `src/ledger.ts` — atomic persistent reference ledger;
- `src/recovery.ts` — observe-before-replay decisions;
- `src/receipt.ts` — authority-separated receipts;
- `src/memory.ts` — evidence-gated trusted promotion;
- `src/kernel.ts` — monolithic reference execution protocol;
- `src/boundary.ts` — split-phase execution boundary for external runners.

### 5.2 Split-phase boundary

Some external runners must retain control of the physical action call. `SplitExecutionBoundary` therefore separates persistence from external dispatch:

```text
prepare(action)
    -> policy / approval
    -> durable possibly_committed
    -> caller may dispatch

recordResponse(actionId)
    -> executed only

recordLostResponse(actionId)
    -> ambiguity remains durable

recover(actionId, observation, evidence)
    -> verified / executed / needs_resolution
```

This interface allows a benchmark to keep its official `env.step(...)` implementation while LHIC owns the durable execution state around it.

### 5.3 Tests

The current artifact contains **16 Node.js tests**:

- 6 core invariant tests;
- 2 monolithic kernel crash/recovery tests;
- 5 recovery-matrix tests;
- 3 split-boundary integration tests.

Additional Python adapter tests exercise the cross-language runner bridge and restart semantics.

## 6. Controlled evaluation

The primary research question is:

> With planner and logical action fixed, does durable ambiguous state plus observation/verification prevent duplicate side effects after non-atomic execution failure?

The evaluation is intentionally systems-oriented and does not test whether LHIC-Core improves planner reasoning quality.

### 6.1 Real surfaces

**Browser.** Real Chromium submits an HTML form to a local HTTP service. Recovery observes DOM state; screenshot bytes can contribute verifier evidence.

**Desktop.** A real Tk window runs in Xvfb and receives an X11 pointer click via `xdotool`. Native window state exposes persisted count and complete/partial postcondition status.

**Code.** Each controlled run uses a real isolated Git repository with actual file writes and commits.

## 7. Flagship post-commit crash experiment

The same failure window is injected on each surface:

```text
persist possibly_committed
        -> dispatch real action
        -> external effect commits
        -> dispatcher is killed
        -> planner receives no completion
        -> restart from durable ledger
        -> observe external state
        -> verify
        -> do not replay
```

| Surface | Trials | Blind-retry duplicates | LHIC duplicates | Verified recovery |
|---|---:|---:|---:|---:|
| Chromium browser | 10 | 10 | 0 | 10 / 10 |
| X11/Tk desktop | 10 | 10 | 0 | 10 / 10 |
| Git/code | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Every accepted LHIC flagship trial physically dispatches once and commits one side effect. The blind-retry baseline commits the same logical effect twice.

An earlier fresh workflow attempt reproduced the same aggregate flagship result. This is runner-repeatability evidence, not a second open-world task distribution.

## 8. Expanded recovery-semantics matrix

| Case | Expected durable behavior | Duplicates | Result |
|---|---|---:|---|
| Pre-dispatch failure | `needs_resolution`; no automatic replay | 0 | PASS |
| Delayed visibility | later re-observe and reach `verified` | 0 | PASS |
| Persistent inconclusive | remain `needs_resolution` | 0 | PASS |
| Duplicate logical delivery | terminal verified identity blocks replay | 0 | PASS |
| Workspace conflict | executed/unverified; no replay | 0 | PASS |

This layer directly motivated treating `needs_resolution` as an explicit recovery state rather than a state that can fall back into ordinary dispatch.

## 9. Seeded randomized cross-surface campaign

The third layer runs six fault modes on all three real surfaces under deterministic seed-derived timing:

1. pre-dispatch failure;
2. post-commit lost response;
3. delayed visibility;
4. partial postcondition;
5. duplicate delivery;
6. late completion after recovery.

Each timing seed executes:

```text
3 surfaces x 6 modes x 3 trials = 54 trials
```

Two timing seeds were evaluated: `2026-08-15` and `2026-08-16`.

| Seed | Trials | Passed | Failed | Duplicate side effects |
|---|---:|---:|---:|---:|
| `2026-08-15` | 54 | 54 | 0 | 0 |
| `2026-08-16` | 54 | 54 | 0 | 0 |
| **Combined** | **108** | **108** | **0** | **0** |

Each fault mode contributes 18 trials across both seeds, and all 18/18 trials for each mode matched the intended durable state.

Injected visibility delays ranged from **41 ms to 220 ms**. Delayed-visibility trials required between **2 and 6 recovery observations** before the external state became visible and verifiable, while physical dispatch remained exactly one.

Partial-postcondition trials committed a real effect while deliberately leaving the complete verifier condition false. LHIC observed the effect, failed verification, preserved executed/unverified state, and did not replay.

## 10. Synthetic ablation harness

The deterministic simulator runs 100 trials per strategy over five modeled failure modes.

| Strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

The simulator is a semantic regression/ablation tool; it does not substitute for real-surface or official benchmark evidence.

## 11. Paired no-fault reference overhead

To separate safety behavior from runtime cost, the artifact includes an 80-trial-per-variant local code microbenchmark. Variants are interleaved and one warm-up per variant is excluded.

| Variant | Mean | Median | p95 |
|---|---:|---:|---:|
| Direct execute | 0.258 ms | 0.182 ms | 0.291 ms |
| Direct execute + read-back verify | 0.406 ms | 0.367 ms | 0.553 ms |
| Split durable boundary | 1.494 ms | 1.506 ms | 1.777 ms |
| Full LHIC-Core | 2.157 ms | 2.108 ms | 2.667 ms |

Median differences are:

```text
split boundary - direct execute       = +1.324 ms
full kernel - direct execute + verify = +1.741 ms
```

These measurements characterize the **academic atomic-JSON reference artifact** only. They do not characterize product SQLite performance, Chromium/UI actions, network APIs, or OSWorld task latency. Because the direct baseline itself is sub-millisecond, the raw full/direct ratio is not a useful production metric.

A publication-quality systems overhead result should next repeat this paired design on the real browser, desktop, and Git fixtures and report confidence intervals.

## 12. External validity: OSWorld 2.0

The first external benchmark target is OSWorld 2.0. The integration point is the boundary between planner output and the official environment step:

```text
agent.predict(instruction, obs)
        -> proposed action
        -> LHIC split boundary
        -> official env.step(action, ...)
```

The benchmark task specification, environment image, action budget, and evaluator remain unchanged. Official task score must be reported separately from LHIC execution metrics.

### 12.1 Cross-language bridge

The current adapter path is:

```text
Python benchmark wrapper
        -> persistent Node subprocess
        -> TypeScript SplitExecutionBoundary
        -> FileSideEffectLedger
        -> durable state
```

Cross-language integration tests validate:

1. `possibly_committed` is durable before the fake benchmark calls `env.step`;
2. successful executor return records `executed`, not `verified`;
3. an exception/lost completion preserves `possibly_committed`;
4. durable state survives bridge-process restart;
5. externally supplied independent evidence can recover to `verified`;
6. adapter failure handling introduces no synthetic blind retry.

### 12.2 Pinned upstream compatibility gate

Academic CI checks out the pinned OSWorld `v2026.06.24` source and statically verifies that the runner still exposes the planner/action/`env.step(...)` boundary assumed by the adapter. This protects the academic artifact from silently drifting away from the pinned upstream runner.

The automatic exact-action approval currently used by the benchmark bridge is a sandbox evaluation configuration intended to isolate execution semantics. It is not a production policy recommendation.

### 12.3 Remaining benchmark work

The adapter can carry durable state, but an official evaluation still requires:

- actual OSWorld VM/environment execution;
- a benchmark-appropriate per-action observation/verifier strategy;
- fault injection that does not alter official task/evaluator scoring;
- runtime ablations under the same planner/model/task budget;
- separate reporting of official OSWorld score and LHIC execution metrics.

Therefore the current work is **OSWorld runner compatibility and boundary integration**, not an OSWorld result.

## 13. Evaluation methodology and ablations

Publication-facing experiments should hold planner, task, environment, action budget, and evaluator fixed while changing only the execution substrate.

At minimum compare:

1. vanilla tool loop;
2. verifier only;
3. durable ledger only;
4. ledger + verifier;
5. full LHIC-Core.

Report task success together with duplicate side effects, false success, unauthorized actions, unsafe replay, recovery success, `needs_resolution` rate, human intervention, verifier failure, added observations, latency overhead, and token/tool-call overhead where relevant.

## 14. Related work

**Verified tool calls under non-atomic failures.** Mansoor, Phadke, and Rana (arXiv:2608.02645) study timeout-after-dispatch, delayed visibility, postcondition verification, verify-before-retry, and idempotency keys. LHIC-Core therefore does not claim verify-before-retry alone as novel. Its research object is the wider execution contract: persistent ambiguous state, authority-separated receipts, bounded approval, and evidence-gated reuse around recovery.

**Contract-grounded tool execution.** ToolGate (arXiv:2601.04688) uses pre/postcondition contracts to gate tool execution and trusted state updates. LHIC-Core is complementary: it emphasizes crash-consistent external ambiguity after an effect may already have committed.

**Runtime safety interception.** AgentTrust (arXiv:2605.04785) and related runtime monitors motivate deterministic interception at the tool boundary. LHIC-Core adds persistent recovery semantics and evidence-carrying execution history.

**Shared workspace state.** STORM (arXiv:2605.20563) manages multi-agent code state at write time. LHIC-Core treats workspace conflict awareness as one form of execution-state mediation rather than its headline novelty.

**Long-horizon evaluation.** OSWorld 2.0 (arXiv:2606.29537) emphasizes hidden-state recovery and skipped verification in long workflows, making it a relevant external-validity target. Tau-bench motivates repeated-run reliability and policy-following measurements.

## 15. Limitations and threats to validity

The current evidence remains controlled. The real surfaces are genuine, but tasks are purpose-built fixtures designed to isolate execution semantics. Two randomized seeds vary timing schedules, not task distribution. The policy classifier is conservative and incomplete. Atomic JSON persistence favors auditability over production throughput. Verifier evidence can itself be wrong. `needs_resolution` improves safety but can reduce availability. Trusted-memory thresholds remain empirical design choices.

The current experiments do not establish higher planner accuracy, general computer-use competence, statistical superiority on open-world tasks, official OSWorld/SWE-bench/tau-bench performance, or production-scale throughput.

## 16. Discussion

LHIC-Core makes a deliberate systems trade-off: explicit uncertainty is preferable to silent replay. In a digital benchmark, a `needs_resolution` outcome may look like lower completion. In irreversible workflows, however, a duplicate purchase, message, destructive write, or credential change may be more costly than a deferred action.

The randomized campaign illustrates this trade-off. Pre-dispatch ambiguity with evidence of absence does not cause automatic retry. Partial postconditions remain executed but unverified. Delayed visibility can trigger multiple observations without another physical dispatch. Duplicate and late logical delivery are absorbed by terminal verified identity.

The architecture also separates model progress from execution reliability. Better planners can be substituted without changing the trust contract. Conversely, the same planner can be compared under multiple runtime ablations, making execution-system effects experimentally distinguishable from planner capability.

## 17. Conclusion

LHIC-Core reframes agent reliability as an execution-systems problem. If planning may be probabilistic, execution truth can still be durable, inspectable, authority-aware, and recoverable. By persisting ambiguity before dispatch, separating execution from verification, bounding approval, retaining unresolved states across invocations, and observing the world before replay, LHIC-Core provides a compact research kernel for safer autonomous execution.

Current controlled evidence shows that these semantics survive real Chromium, X11/Tk, and Git boundaries across a fixed SIGKILL window, adjacent recovery cases, and **108 seeded randomized trials without duplicate replay**. A split-phase boundary now connects the same durable semantics to an OSWorld-style external runner through a tested Python→Node→TypeScript bridge, while a paired no-fault microbenchmark quantifies reference-artifact cost without presenting it as production latency. The next step is an actual pinned official benchmark run with independent per-action verification and unchanged evaluator scoring.
