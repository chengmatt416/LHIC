# LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents

> **Status:** pre-submission research draft. Controlled artifact results reported here are internal-validity experiments, not official benchmark or universal SOTA claims.

## Abstract

Autonomous agents increasingly act through browsers, desktop interfaces, coding workspaces, shell commands, and external services. These actions are not atomic with the agent's tool-call response: an external side effect may commit before the dispatcher fails, a completion may be lost after the world has changed, a postcondition may become visible only after a delay, or a stale logical completion may arrive after recovery has already succeeded. Conventional agent loops often collapse these cases into binary tool-call success/failure and retry after missing completion, creating duplicate side effects, false completion, unsafe replay, or ambiguous provenance.

We present **LHIC-Core**, a model-independent execution kernel that separates probabilistic planning from execution truth. A planner proposes actions, while LHIC-Core independently classifies risk, enforces bounded approval, persists `possibly_committed` state before external dispatch, observes the external world during recovery, verifies postconditions, records authority-separated receipts, and blocks replay while an action remains unresolved. The academic artifact extracts these mechanisms from the full LHIC product into a compact TypeScript reference implementation with executable invariants, synthetic ablations, real Chromium/X11/Git failure-injection experiments, and an external benchmark boundary scaffold.

In a controlled post-commit/pre-response crash experiment over Chromium, X11/Tk, and Git, blind retry produced one duplicate side effect in every one of 30 trials, while LHIC-Core produced zero duplicates and recovered to `verified` in all 30. A five-case semantic matrix validates adjacent ambiguity states. A third seeded randomized campaign executed **108 additional real-surface trials** over six fault modes and two timing schedules; all 108 matched their expected durable state and produced zero duplicate side effects. Delayed-visibility trials required between two and six recovery observations while retaining exactly one physical dispatch. These experiments support a narrow systems claim about execution semantics under controlled non-atomic failures; they do not establish general planning superiority or benchmark SOTA. The next external-validity layer interposes the same trust boundary into a pinned official benchmark runner while leaving its task setup and evaluator unchanged.

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

The planner is consequently not trusted to self-certify:

- authorization;
- side-effect risk;
- execution success;
- postcondition verification;
- evidence quality.

The execution layer should fail closed when it lacks evidence about a potentially irreversible effect.

## 3. Design overview

### 3.1 Independent risk classification

The runtime independently infers a side-effect class from the action surface, tool, intent, target, and origin. The planner may supply a proposed class, but effective risk is monotone with respect to independent runtime inference: the planner may raise risk but may never lower it.

### 3.2 Bounded approval scopes

Approval is structured authority rather than a boolean flag. The reference model supports:

- exact-action scope;
- plan-step scope;
- read-only task scope;
- bounded origin/action-class scope.

High-risk actions cannot inherit broad reusable scopes. Approval can bind action hash, expiry, origin, class, and usage count.

### 3.3 Durable side-effect ledger

Before physical dispatch, LHIC-Core persists the action as `possibly_committed`.

This ordering is the crash-consistency mechanism. If the process dies immediately after dispatch, durable state already records that the external world may have changed. The system does not silently return to a clean pre-dispatch state.

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
effect absent    -> retain explicit resolution state; retry requires policy admission
inconclusive     -> needs_resolution; do not replay
```

A critical refinement from the failure-matrix experiments is that `needs_resolution` is itself an unresolved recovery state. A later call must re-observe it; it is not a clean slate that can fall through to normal dispatch.

The runtime therefore treats the following states as non-dispatchable without recovery analysis:

```text
possibly_committed
executed
needs_resolution
verified
```

`verified` is terminal; the other three require recovery semantics.

### 3.5 Authority-separated receipts

An action receipt decomposes “success” into explicit facts. It records action identity, risk class, approval authority, execution authority, verifier authority, ledger state, and evidence.

Executor success is not upgraded to verification unless an independent verifier emits passing, non-empty evidence. A replay-blocked call against a previously verified identity illustrates the distinction: the durable ledger remains terminally `verified`, while a new receipt with no new verifier evidence does not pretend a fresh verification occurred.

### 3.6 Trust-aware learned behavior

Reusable learned behavior is promoted only after multiple independent verified task identities plus holdout success, with code-anchor staleness checks where applicable. Repeating one task identity cannot manufacture independent evidence.

This mechanism does not assume that memory improves raw task performance. Its purpose is narrower: if behavior becomes reusable, its trust state should reflect objective execution evidence rather than model narration.

## 4. Formal execution model

The operational model is specified in `docs/research/formal-model.md`.

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

The research branch is intentionally smaller than the product branch. The executable kernel is under `src/`:

- `model.ts` — actions, risk classes, approvals, ledger entries, evidence, receipts, and memory;
- `policy.ts` — independent risk inference and monotonic effective risk;
- `approval.ts` — bounded approval semantics;
- `ledger.ts` — persistent fail-closed state transitions;
- `recovery.ts` — observe-before-replay decisions;
- `receipt.ts` — authority-separated receipts;
- `memory.ts` — evidence-gated trusted promotion and staleness;
- `kernel.ts` — composition of policy, ledger, execution, observation, verification, and receipt emission.

The product branch uses richer database-backed storage and multiple surface integrations. The academic branch replaces product coupling with inspectable reference interfaces and atomic JSON persistence. The goal is auditability of the protocol, not production throughput.

### 5.1 Executable tests

The current artifact has 13 Node.js tests:

- 6 core invariant tests;
- 2 kernel-level crash/recovery integration tests;
- 5 recovery-matrix tests covering adjacent ambiguity semantics.

The five matrix-related properties are:

1. absent effect after ambiguous dispatch state does not auto-dispatch;
2. delayed visibility can later verify without duplicate dispatch;
3. repeated inconclusive observations remain non-dispatchable;
4. duplicate logical delivery cannot re-dispatch a verified identity;
5. workspace conflict prevents false verified completion without replay.

### 5.2 Experiment layers

The artifact intentionally separates three forms of evidence:

1. **synthetic semantic regression** — fast deterministic ablation coverage;
2. **controlled real-surface integration** — real Chromium, X11/Tk, and Git side effects under injected failures;
3. **external benchmark interposition** — a thin adapter boundary intended to preserve an official benchmark's task and scoring contract.

## 6. Controlled evaluation

### 6.1 Research question

The primary evaluation asks:

> With the planner and logical action fixed, does durable ambiguous state plus observation/verification prevent duplicate side effects after non-atomic execution failure?

The evaluation is intentionally systems-oriented. It does not test whether LHIC-Core improves the planner's reasoning quality.

### 6.2 Real execution surfaces

**Browser.** A real Chromium instance submits an HTML form to a local HTTP server. The server commits external state. Recovery performs fresh DOM observation; screenshot bytes can contribute verifier evidence.

**Desktop.** A real Tk window runs inside Xvfb. `xdotool` delivers an X11 pointer click to a visible button. The fixture persists its count and exposes both `count` and `status=complete|partial` in native observable state.

**Code.** An isolated real Git repository is created. The action writes a feature marker and creates a real commit. Complete-postcondition cases additionally create a required state file; partial cases deliberately omit it.

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

The baseline uses blind retry after lost completion. LHIC-Core uses durable recovery.

### 7.1 Results

The workflow runs 10 trials per surface.

| Surface | Trials | Blind-retry duplicate effects | LHIC duplicate effects | LHIC verified recovery |
|---|---:|---:|---:|---:|
| Chromium browser | 10 | 10 | 0 | 10 / 10 |
| X11/Tk desktop | 10 | 10 | 0 | 10 / 10 |
| Git/code | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Every LHIC trial in the flagship experiment exhibits one physical dispatch, one committed side effect, and zero duplicate side effects. The blind-retry baseline commits the same logical effect twice.

An earlier fresh GitHub Actions rerun reproduced the same aggregate result. That is useful runner-repeatability evidence, but both attempts use the same controlled fixtures and do not represent independent open-world tasks.

## 8. Expanded five-case recovery matrix

The second evaluation layer varies adjacent ambiguity semantics.

| Case | External truth | Expected durable behavior | Result |
|---|---|---|---|
| Pre-dispatch / absent effect | no side effect exists | `needs_resolution`; no automatic replay | PASS |
| Delayed visibility | effect exists but first observation is inconclusive | later re-observe and reach `verified` | PASS |
| Persistent inconclusive observation | evidence cannot determine external state | remain `needs_resolution` | PASS |
| Duplicate logical delivery | action identity already verified | block second dispatch | PASS |
| Workspace conflict | effect exists but postcondition conflicts | remain executed/unverified; no replay | PASS |

All five controlled cases preserve one-dispatch semantics and zero duplicate side effects.

This layer exposed a meaningful design requirement: `needs_resolution` must remain part of the recovery state set. A later invocation re-observes rather than silently returning to normal dispatch.

## 9. Seeded randomized cross-surface campaign

The third evaluation layer runs six fault modes on all three real surfaces under deterministic seed-derived timing.

Fault modes are:

1. `pre_dispatch_failure`;
2. `post_commit_lost_response`;
3. `delayed_visibility`;
4. `partial_postcondition`;
5. `duplicate_delivery`;
6. `late_completion_after_recovery`.

Each timing seed executes:

```text
3 surfaces x 6 modes x 3 trials = 54 trials
```

Two schedules were evaluated:

- seed `2026-08-15`;
- seed `2026-08-16`.

### 9.1 Aggregate result

| Seed | Trials | Passed | Failed | Duplicate side effects |
|---|---:|---:|---:|---:|
| `2026-08-15` | 54 | 54 | 0 | 0 |
| `2026-08-16` | 54 | 54 | 0 | 0 |
| **Combined** | **108** | **108** | **0** | **0** |

Each fault mode contributes 18 trials across both seeds. All 18/18 trials for each mode matched the expected durable state.

### 9.2 Delayed visibility

Injected visibility delays ranged from **41 ms to 220 ms**. Delayed-visibility trials required between **2 and 6 recovery observations** before the external state became visible and verifiable. Despite repeated recovery entry, the physical dispatch count remained exactly one.

This result is stronger than a fixed two-observation test because different seeded timing schedules produce different recovery depths while exercising the same durable state semantics.

### 9.3 Partial postconditions

For partial-postcondition trials, a real side effect commits but the complete verifier condition is deliberately false. LHIC-Core observes the effect, fails verification, preserves the action as executed/unverified, and does not replay it. A second recovery invocation repeats observation/verification rather than physical execution.

### 9.4 Duplicate and late logical delivery

Duplicate-delivery trials first complete and verify normally, then deliver the same action identity again. Late-completion trials lose the first completion, recover and verify independently, then deliver the logical action again. In both cases, terminal verified identity prevents a second physical dispatch.

## 10. Synthetic ablation harness

The deterministic synthetic harness remains a fast semantic regression suite. It runs 100 trials per strategy over five modeled failure modes.

| Strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

The simulator does not replace the real-surface experiments. It provides fast semantic coverage and exposes the safety/availability trade-off of explicit uncertainty.

## 11. Diagnostic timing and overhead methodology

The randomized campaign records harness-level elapsed time:

| Surface | Randomized trials | Mean case latency | Median case latency |
|---|---:|---:|---:|
| Browser / Chromium | 36 | ~302 ms | 289 ms |
| Desktop / X11 + Tk | 36 | ~199 ms | 196 ms |
| Code / Git | 36 | ~43 ms | 21 ms |

These values are **not LHIC runtime-overhead claims**. They include deliberately injected wait time, browser/navigation cost, UI fixture startup, Git operations, and verification work.

A publication-quality overhead claim requires paired no-fault trials with the same external action under at least:

- direct execution baseline;
- durable-ledger boundary only;
- ledger + verifier;
- full LHIC-Core.

Metrics should decompose:

- pre-dispatch persistence latency;
- action execution latency;
- observation count and time;
- verifier count and time;
- total end-to-end latency;
- additional filesystem writes/tool calls/tokens where relevant.

## 12. Evaluation methodology and ablations

Publication-facing experiments should hold planner, task, environment, action budget, and evaluator fixed while changing only the execution substrate.

At minimum compare:

1. vanilla tool loop;
2. verifier only;
3. durable ledger only;
4. ledger + verifier;
5. full LHIC-Core.

Report task success together with:

- duplicate side effects;
- false success;
- unauthorized actions;
- unsafe replay;
- recovery success;
- `needs_resolution` rate;
- human intervention;
- verifier failure;
- added observations;
- latency overhead;
- token/tool-call overhead where relevant.

## 13. External validity: OSWorld 2.0 boundary

The first external benchmark target is OSWorld 2.0. The adapter must preserve the benchmark contract rather than create an LHIC-specific evaluator.

The intended integration point is the boundary between planner output and the official environment step:

```text
agent.predict(instruction, obs)
        -> proposed action
        -> LHIC execution boundary
        -> official env.step(action, ...)
```

The OSWorld task specification, environment image, max-step budget, and evaluator remain unchanged. Official task score is reported separately from LHIC execution metrics.

`adapters/osworld-v2/runner_boundary.py` currently defines the benchmark-side interposition contract. Its tests require:

1. `before_dispatch` to execute before `env.step`, so ambiguity can be made durable before any physical action;
2. a return from `env.step` to be recorded as execution evidence only, not independent verification;
3. exceptions/timeouts to be recorded as lost responses and re-raised rather than converted into blind retry.

The Python scaffold deliberately does not reimplement the TypeScript LHIC state machine. The next implementation step is a bridge from this benchmark-side boundary to the research kernel or product runtime.

## 14. Related work

**Verified tool calls under non-atomic failures.** Mansoor, Phadke, and Rana (arXiv:2608.02645) study timeout-after-dispatch, delayed visibility, postcondition verification, verify-before-retry, and idempotency keys. LHIC-Core therefore does not claim verify-before-retry alone as novel. Its research object is the wider execution contract: persistent ambiguous state, authority-separated receipts, bounded approval, and evidence-gated reuse around recovery.

**Contract-grounded tool execution.** ToolGate (arXiv:2601.04688) uses pre/postcondition contracts to gate tool execution and trusted state updates. LHIC-Core is complementary: it emphasizes crash-consistent external ambiguity after an effect may already have committed.

**Runtime safety interception.** AgentTrust (arXiv:2605.04785) and related runtime monitors motivate deterministic interception at the tool boundary. LHIC-Core adds persistent recovery semantics and evidence-carrying execution history.

**Shared workspace state.** STORM (arXiv:2605.20563) manages multi-agent code state at write time. LHIC-Core treats workspace conflict awareness as one form of execution-state mediation rather than its headline novelty.

**Long-horizon evaluation.** OSWorld 2.0 (arXiv:2606.29537) emphasizes hidden-state recovery and skipped verification in long workflows, making it a relevant external-validity target. Tau-bench motivates repeated-run reliability and policy-following measurements.

## 15. Limitations and threats to validity

The current evidence remains controlled. The surfaces are genuine, but the tasks are purpose-built fixtures designed to isolate execution semantics. Two randomized seeds vary timing schedules, not task distribution. The policy classifier is conservative and incomplete. Atomic JSON persistence favors auditability over production throughput. Verifier evidence can itself be wrong. `needs_resolution` improves safety but can reduce availability. Trusted-memory thresholds remain empirical design choices.

The current experiments do not establish:

- higher planner accuracy;
- general computer-use competence;
- statistical superiority on open-world tasks;
- official OSWorld, SWE-bench, or tau-bench performance;
- production-scale throughput.

## 16. Discussion

LHIC-Core makes a deliberate systems trade-off: explicit uncertainty is preferable to silent replay. In a digital benchmark, a `needs_resolution` outcome may look like lower completion. In irreversible workflows, however, a duplicate purchase, message, destructive write, or credential change may be more costly than a deferred action.

The randomized campaign illustrates this trade-off. Pre-dispatch ambiguity with evidence of absence does not cause an automatic retry. Partial postconditions remain executed but unverified. Delayed visibility can trigger multiple observations without another physical dispatch. Duplicate and late logical delivery are absorbed by terminal verified identity.

The architecture also separates model progress from execution reliability. Better planners can be substituted without changing the trust contract. Conversely, the same planner can be compared under multiple runtime ablations, making execution-system effects experimentally distinguishable from planner capability.

## 17. Conclusion

LHIC-Core reframes agent reliability as an execution-systems problem. If planning may be probabilistic, execution truth can still be durable, inspectable, authority-aware, and recoverable. By persisting ambiguity before dispatch, separating execution from verification, bounding approval, retaining unresolved states across invocations, and observing the world before replay, LHIC-Core provides a compact research kernel for safer autonomous execution.

Current controlled evidence shows that these semantics survive real Chromium, X11/Tk, and Git boundaries across a fixed SIGKILL window, adjacent recovery cases, and **108 seeded randomized trials without duplicate replay**. The next step is external validity: connect the same boundary to pinned official benchmark runners while preserving their task and evaluator contracts, and pair safety measurements with explicit no-fault overhead analysis.
