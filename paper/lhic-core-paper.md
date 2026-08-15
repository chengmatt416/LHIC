# LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents

> **Status:** pre-submission research draft. Results in this document are controlled artifact-validation results, not external benchmark or universal SOTA claims.

## Abstract

Autonomous agents increasingly act through browsers, desktop interfaces, coding workspaces, shell commands, and external services. These actions are not atomic with the agent's tool-call response: an external side effect may commit before the dispatcher crashes, a response may be lost after the real world has changed, or the postcondition may become visible only later. Conventional agent loops frequently collapse these cases into a binary success/failure signal and retry after missing completion, creating duplicate side effects, false completion, or unsafe replay.

We present **LHIC-Core**, a model-independent execution kernel that separates probabilistic planning from execution truth. The planner proposes actions, while LHIC-Core independently classifies risk, enforces bounded approval, persists a durable ambiguous state before external dispatch, observes the external world during recovery, verifies postconditions, records authority-separated receipts, and blocks replay while an action remains unresolved. The academic artifact extracts these mechanisms from the full LHIC product into a compact TypeScript reference implementation with executable invariants, a synthetic semantic harness, real Chromium/X11/Git failure-injection experiments, and an expanded recovery-state matrix.

In the controlled flagship experiment, the same post-commit/pre-response crash is injected across Chromium browser actions, native X11/Tk desktop actions, and real Git commits. Across 30 trials per workflow attempt, blind retry produces one duplicate side effect in every trial, whereas LHIC-Core produces zero duplicates and reaches verified recovery in all 30 trials. A fresh rerun reproduces the same qualitative result. An expanded five-case matrix additionally validates pre-dispatch ambiguity, delayed visibility, persistent inconclusive observation, duplicate logical delivery, and workspace conflict; all five cases preserve one-dispatch semantics and zero duplicate side effects. These results establish internal validity for the execution protocol, not general computer-use superiority. External-validity evaluation on official benchmark tasks and systematic overhead analysis remain future work.

## 1. Introduction

Modern agent evaluations often emphasize planning quality: the model observes context, chooses a tool call, receives a result, and continues. This abstraction hides a systems problem. A tool-call return value is not identical to execution truth.

A browser form can submit before the automation process dies. A GUI click can persist state before an RPC returns. A Git commit can be written to disk while the agent loses the completion frame. A remote service may accept a request but expose the resulting state only after an eventually consistent delay. In each case, the planner can receive the same symptom—missing or failed completion—despite different external realities.

The retry decision is therefore epistemic rather than purely procedural. After dispatch, the runtime may no longer know whether replay is safe. Treating every missing response as “the effect did not happen” can duplicate purchases, messages, destructive writes, credential changes, or commits. Treating every accepted tool call as “verified success” can instead create false completion. A third problem appears when a model is allowed to self-describe risk or success and the execution framework trusts that description as authority.

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

The current evaluation deliberately holds planning sophistication out of the claim. The artifact studies whether the execution substrate can prevent duplicate replay and false verification under controlled failures.

## 2. Problem model

We model an agent that proposes actions against an external environment. The environment may expose side effects through a browser, desktop UI, local code workspace, shell, network control plane, or remote API.

The runtime must handle at least the following conditions:

1. failure before physical dispatch;
2. failure after dispatch but before completion response;
3. delayed visibility of a committed effect;
4. partial or conflicting postcondition state;
5. duplicated or delayed executor responses;
6. repeated delivery of the same logical action identity;
7. planner-supplied risk understatement;
8. expired or over-broad approval;
9. stale learned state;
10. concurrent external workspace modification.

### 2.1 Why binary tool status is insufficient

A missing response is evidence about the communication path, not the external world. After a non-atomic dispatch, at least three states can be observationally compatible with “tool failed”:

- no external effect occurred;
- the full intended effect occurred;
- some ambiguous or conflicting state occurred.

The runtime must therefore preserve uncertainty instead of collapsing these states into a single retryable failure.

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

The runtime independently infers a side-effect class from the action surface, tool, intent, target, and origin. The planner may supply a proposed class, but the effective class is monotone with respect to independent runtime inference: the planner may raise risk but may never lower it.

This prevents a planner from granting itself a weaker safety policy by labeling a purchase, credential change, or destructive action as a local edit.

### 3.2 Bounded approval scopes

Approval is structured authority rather than a boolean flag. The reference model supports:

- exact-action scope;
- plan-step scope;
- read-only task scope;
- bounded origin/action-class scope.

High-risk actions such as purchases, financial transfers, credential changes, destructive operations, and administrative/security changes cannot inherit broad reusable scopes. Approval can bind action hash, expiry, origin, class, and usage count.

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

effect absent    -> remain explicit about resolution; retry requires policy admission

inconclusive     -> needs_resolution; do not replay
```

A critical refinement from the expanded failure matrix is that `needs_resolution` is itself an unresolved recovery state. A later call must re-observe it; it is not a clean slate that can fall through to normal dispatch.

The runtime therefore treats the following states as non-dispatchable without recovery analysis:

```text
possibly_committed
executed
needs_resolution
verified
```

`verified` is terminal; the other three require observation/recovery semantics.

### 3.5 Authority-separated receipts

An action receipt decomposes “success” into explicit facts. It records action identity, risk class, approval authority, execution authority, verifier authority, ledger state, and evidence.

Executor success is not upgraded to verification unless an independent verifier emits passing, non-empty evidence. This distinction matters during replay, audit, and trusted learning.

A replay-blocked call against a previously verified identity illustrates the distinction: the durable ledger can remain terminally `verified`, while a new receipt that contains no new verifier evidence does not pretend a fresh verification occurred.

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

The current artifact is an executable operational model, not a machine-checked proof. Encoding the transition system in TLA+, Alloy, Lean, or another formal method is future work.

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

The current artifact has 13 tests:

- 6 core invariant tests;
- 2 kernel-level crash/recovery integration tests;
- 5 recovery-matrix tests covering adjacent ambiguity semantics.

The five matrix-related properties are:

1. absent effect after ambiguous dispatch state does not auto-dispatch;
2. delayed visibility can later verify without duplicate dispatch;
3. repeated inconclusive observations remain non-dispatchable;
4. duplicate logical delivery cannot re-dispatch a verified identity;
5. workspace conflict prevents false verified completion without replay.

## 6. Controlled evaluation

### 6.1 Research question

The primary evaluation asks:

> With the planner and logical action fixed, does durable ambiguous state plus observation/verification prevent duplicate side effects after non-atomic execution failure?

The evaluation is intentionally systems-oriented. It does not test whether LHIC-Core improves the planner's reasoning quality.

### 6.2 Real execution surfaces

The flagship experiment runs on three external-state surfaces.

**Browser.** A real Chromium instance submits an HTML form to a local HTTP server. The server commits a counter increment. The dispatcher is killed only after navigation confirms that commit. Recovery launches a fresh browser observation and uses DOM state plus screenshot-derived evidence.

**Desktop.** A real Tk native window runs inside Xvfb. `xdotool` delivers an X11 mouse click to a deterministically positioned button. The UI persists the counter and exposes it in the window title. The worker is killed after the visible state changes; recovery inspects the X11 state and persisted fixture state.

**Code.** An isolated real Git repository is created. The worker appends a marker, stages the change, creates a Git commit, and is killed immediately after commit. Recovery checks both file content and Git history.

### 6.3 Flagship failure injection

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

### 6.4 Flagship results

The workflow runs 10 trials per surface.

| Surface | Trials | Blind-retry duplicate effects | LHIC duplicate effects | LHIC verified recovery |
|---|---:|---:|---:|---:|
| Chromium browser | 10 | 10 | 0 | 10 / 10 |
| X11/Tk desktop | 10 | 10 | 0 | 10 / 10 |
| Git/code | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Every LHIC trial in the flagship experiment exhibits:

```text
firstState       = possibly_committed
recoveredState   = verified
dispatches       = 1
observations     = 1
verifications    = 1
sideEffects      = 1
duplicateEffects = 0
```

The blind-retry baseline commits two effects for each logical action, producing one duplicate per trial.

A fresh rerun on the same controlled fixtures reproduces the same qualitative aggregate result. This repeatability check reduces the likelihood of a one-off runner artifact, but it is not equivalent to sampling a new real-world task distribution.

## 7. Expanded recovery-semantics matrix

The flagship experiment isolates one important failure interval. The expanded matrix varies adjacent recovery semantics.

| Case | External truth | Expected behavior |
|---|---|---|
| Pre-dispatch / absent effect | no side effect exists | remain explicit; no automatic physical replay |
| Delayed visibility | effect exists but first observation is inconclusive | stay non-dispatchable; later re-observe and verify |
| Persistent inconclusive observation | evidence cannot determine external state | remain `needs_resolution`; no replay |
| Duplicate logical delivery | action identity already verified | block second dispatch |
| Workspace conflict | intended effect exists but external state changed | do not replay; refuse verified completion |

All five controlled cases pass the artifact's hard acceptance gates with zero duplicate side effects.

### 7.1 Delayed visibility

This case is particularly important because the external effect exists while the first recovery observation intentionally returns `inconclusive`.

The expected path is:

```text
possibly_committed
   -> observation #1: inconclusive
   -> needs_resolution
   -> later invocation: re-observe, do not dispatch
   -> observation #2: effect_present
   -> verify postcondition
   -> verified
```

The mechanism counts are:

```text
dispatches      = 1
observations    = 2
verifications   = 1
sideEffects     = 1
duplicateEffects = 0
```

This experiment directly changed the reference kernel: `needs_resolution` was promoted to an explicit recovery state so later calls cannot silently return to normal dispatch semantics.

### 7.2 Persistent inconclusive state

If observation remains inconclusive, the action remains `needs_resolution`. This is a deliberate safety/availability trade-off. The runtime prefers preserved uncertainty to an irreversible duplicate effect.

### 7.3 Duplicate logical delivery

A verified action identity is terminal in the durable ledger. A duplicate delivery therefore produces no second physical dispatch. The receipt path also preserves authority discipline: a new replay-blocked receipt without fresh verifier evidence does not claim a new verification event.

### 7.4 Workspace conflict

The fixture commits the intended file-side effect and then introduces an external mutation before recovery verification. Observation establishes that an effect exists; the verifier fails the intended postcondition. The runtime does not replay and does not claim verified completion.

## 8. Synthetic ablation harness

The deterministic synthetic harness remains a fast semantic regression suite. It runs 100 trials per strategy over five modeled failure modes.

| Strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

The simulator does not replace the real-surface experiments. It provides fast semantic coverage and exposes the safety/availability trade-off of explicit uncertainty.

## 9. Overhead and safety–availability trade-off

LHIC-Core's protection is not free. Recovery can require additional external observations and verifier invocations.

In the current five-case semantic matrix, five logical actions require a total of six recovery observations and three verifier calls while preserving exactly one physical dispatch per logical action. The delayed-visibility case alone requires two observations because external truth changes from unavailable to observable over time.

Small fixture wall-clock timings vary substantially between fresh CI runners, so they are not treated as production performance claims. Publication-level evaluation should report:

- end-to-end latency distributions;
- added observation/tool calls;
- verifier invocations;
- token overhead where a model-backed verifier is used;
- `needs_resolution` and human-intervention rate;
- irreversible-error or duplicate-side-effect rate.

The meaningful comparison is therefore a safety–availability–latency frontier rather than task completion alone.

## 10. Evaluation plan for external validity

The next experiments should hold planner, tasks, environment, and budget fixed while changing execution semantics.

### 10.1 Runtime ablations

At minimum:

1. vanilla retry loop;
2. verifier only;
3. durable ledger only;
4. ledger + verifier;
5. full LHIC-Core.

Policy-only and approval-scope ablations can isolate supporting security overhead.

### 10.2 Broader failure injections

The next layer should include:

- multiple randomized pre/post-dispatch timing points across browser, desktop, and code;
- delayed, duplicated, and reordered executor responses;
- mixed/partial postconditions;
- larger concurrent workspace mutations;
- planner risk understatement;
- approval replay and expiry;
- stale trusted memory.

### 10.3 External benchmark adapters

Relevant external-validity targets include long-horizon computer-use tasks, policy-following tool-agent tasks, and coding tasks with objective file/repository verification. Official evaluator scoring must remain unchanged; LHIC-Core should wrap execution rather than redefine success.

Repeated trials and confidence intervals should be reported where task nondeterminism matters.

## 11. Related work

**Verified tool calls under non-atomic failures.** Mansoor, Phadke, and Rana (arXiv:2608.02645) study timeout-after-dispatch, delayed visibility, postcondition verification, verify-before-retry, and idempotency. LHIC-Core therefore does not claim verify-before-retry alone as novel. Its research object is the larger execution contract around durable ambiguity, authority separation, approval, recovery state, and trusted reuse.

**Contract-grounded tool execution.** ToolGate (arXiv:2601.04688) applies formal preconditions and postconditions to tool execution and trusted symbolic-state updates. LHIC-Core is complementary: it focuses on external side effects that may already have committed before the runtime receives a trustworthy result.

**Runtime safety interception.** AgentTrust (arXiv:2605.04785) and ClawGuard (arXiv:2604.11790) motivate deterministic enforcement at the tool boundary. LHIC-Core adds stateful recovery from non-atomic side effects and evidence-carrying execution history.

**Execution provenance.** Agent-Sentry (arXiv:2603.22868) uses execution traces to learn behavioral bounds. LHIC-Core instead uses explicit per-action authority and verifier evidence as operational execution truth for recovery and trusted reuse.

**Shared workspace state.** STORM (arXiv:2605.20563) mediates shared code state and conflicts at write time. LHIC-Core treats workspace conflict as one instance of a broader external-state recovery problem rather than the headline contribution.

**Long-horizon evaluation and memory.** OSWorld 2.0 (arXiv:2606.29537) motivates long-horizon external-validity testing around hidden state and verification. tau-bench (arXiv:2406.12045) motivates repeated-run reliability. Hajimiri et al. (arXiv:2606.15017) show that memory/skill modules do not automatically outperform budget-matched baselines, supporting LHIC-Core's narrower claim about trustworthiness rather than guaranteed raw performance gain.

## 12. Limitations and threats to validity

The current evidence is controlled. The fixtures are deterministic and intentionally isolate execution semantics. They do not establish open-world planning quality, universal computer-use reliability, or SOTA performance.

The academic branch is a reference artifact rather than the full production runtime. Atomic JSON persistence prioritizes auditability over throughput. The policy classifier is conservative and incomplete. Verifier evidence can itself be wrong. `needs_resolution` can reduce availability and increase human intervention. Trusted-memory thresholds require empirical calibration.

The current expanded matrix covers five adjacent failure semantics but does not yet randomize visibility delay distributions, emulate partial remote commits, or execute the same failure timing matrix across all three real surfaces.

Finally, the operational invariants are executable but not machine-checked. Formal verification remains future work.

## 13. Discussion

LHIC-Core deliberately prefers explicit uncertainty to silent replay. In a benchmark that rewards only completion, this conservatism can appear as lower availability. In an irreversible workflow, however, duplicate purchase, duplicate message, destructive write, or credential change may be substantially more costly than deferred completion.

The expanded matrix illustrates why uncertainty must remain durable across repeated calls. It is insufficient to protect only the immediate restart after a crash; unresolved states must remain non-dispatchable until external evidence changes the recovery decision.

The design also decouples model progress from execution reliability. A better planner can be substituted without changing the trust contract, while the same planner can be compared under different runtime semantics. This separation is useful both scientifically and operationally.

## 14. Conclusion

LHIC-Core reframes agent reliability as an execution-systems problem. A probabilistic planner should not own execution truth. By persisting ambiguity before dispatch, treating unresolved states as durable recovery states, separating execution from verification, enforcing bounded authority, and observing the external world before replay, LHIC-Core provides a compact research kernel for safer autonomous side-effect execution.

The current artifact demonstrates the protocol on real browser, desktop, and Git process boundaries and across an expanded recovery-semantics matrix. The next step is not broader marketing claims, but external-validity evaluation, overhead measurement, and formalization of the transition system.
