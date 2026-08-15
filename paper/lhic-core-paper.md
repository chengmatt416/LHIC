# LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents

> **Status:** pre-submission research draft. The controlled artifact results reported here are sanity checks for the reference semantics, not external benchmark claims.

## Abstract

Autonomous agents increasingly act through browsers, desktops, shell commands, and external tools. These actions are not atomic: a process can crash after dispatch, a UI action can take effect before a response frame is returned, and a timeout can occur after the external state has already changed. Conventional agent loops often collapse these cases into a binary tool-call success or failure signal, which can cause duplicate side effects, false success, unsafe replay, or unverified learned behavior.

We present **LHIC-Core**, an execution kernel that separates planning from execution truth. A planner proposes actions, while LHIC-Core independently classifies risk, enforces bounded approval scopes, persists `possibly_committed` state before external dispatch, verifies postconditions, records authority-separated receipts, and recovers from ambiguous outcomes by re-observing the external world before replay. The academic artifact extracts these mechanisms from the full LHIC product into a dependency-light TypeScript reference implementation, executable invariant tests, and a deterministic failure-injection harness. In the current synthetic sanity check, naive and verifier-only retry policies duplicate side effects under injected non-atomic failures, while the full reference semantics eliminate duplicate replay in the simulator and reduce human-resolution demand relative to a ledger-only baseline. These results are internal-validity checks; the intended publication claim requires repeated real-environment evaluation with the same planner across runtime ablations.

## 1. Introduction

Modern agents are often evaluated as planners: they observe context, choose a tool call, receive a result, and continue. This abstraction hides a systems problem. A tool-call return value is not identical to execution truth. A purchase button may have been clicked before the browser crashed. A file edit may have reached disk while the agent lost its response. A web form may have submitted but only become visible after a delay. A model may also understate risk if a framework trusts the model's own action label.

The resulting reliability problem is qualitatively different from ordinary planning error. After dispatch, the system may no longer know whether retry is safe. Treating every missing response as “no effect” can duplicate irreversible actions. Treating every accepted call as “verified success” can create false completion. Treating model-generated risk labels as authority can allow the planner to weaken its own constraints.

LHIC-Core asks a narrower question: **what execution substrate should exist underneath a probabilistic planner?** We explore a crash-consistent, evidence-carrying runtime that treats side effects as durable state transitions rather than ephemeral tool-call returns.

The central thesis is:

> Planning may be probabilistic; execution truth should be explicit, durable, and independently verifiable.

## 2. Problem model

We consider an agent that proposes actions against an external environment. The environment may exhibit:

1. failure before dispatch;
2. failure after dispatch but before response;
3. delayed effect visibility;
4. partial or ambiguous state change;
5. duplicate or delayed responses;
6. misleading planner-supplied risk labels;
7. stale learned state;
8. concurrent workspace modifications.

A vanilla agent loop commonly retries after failure. This can be correct before dispatch and unsafe after dispatch. The runtime must therefore distinguish states such as **not attempted**, **possibly committed**, **executed**, **verified**, and **needs resolution**.

Our threat model does not assume a malicious base model. It assumes only that planner output and tool-call responses can be incomplete, stale, mistaken, or interrupted. The execution substrate must therefore fail closed when it lacks evidence about an irreversible effect.

## 3. Design overview

LHIC-Core contains five coupled mechanisms.

### 3.1 Independent risk classification

The runtime independently infers a side-effect class from the action surface, tool, intent, target, and origin. A planner may also propose a class, but the effective class is monotone with respect to independently inferred risk: the planner may raise effective risk, never lower it.

This rule prevents the planner from granting itself a weaker policy classification.

### 3.2 Bounded approval scopes

Approvals are represented as one of four structured scopes:

- exact action;
- plan step;
- read-only task;
- bounded origin/action-class scope.

High-risk actions—purchase, financial transfer, credential change, destructive actions, and administrative/security changes—cannot use broad reusable scopes. Scope validation binds to action hash, expiry, origin/class, and action-count limits where applicable.

### 3.3 Durable side-effect ledger

Before external dispatch, LHIC-Core persists an action as `possibly_committed`. This is the critical crash-consistency step. A crash after dispatch therefore leaves durable evidence that the external effect may have occurred. The system does not silently return to a pre-dispatch state.

`verified` is terminal for an action identity. A verified action cannot be dispatched again under the same identity.

### 3.4 Verify-before-retry recovery

For an ambiguous action, LHIC-Core re-observes the external world before replay:

```text
effect present   -> verify postcondition; do not replay
effect absent    -> retry may be admitted by policy
inconclusive     -> needs_resolution
```

The runtime therefore represents uncertainty explicitly instead of forcing every case into success or failure.

### 3.5 Authority-separated receipts and trusted reuse

Every action receipt distinguishes planner, approval, execution, and verification authority. Executor success does not imply postcondition verification. A receipt reaches `verified` only when passing verifier evidence is present and non-empty.

Trusted reuse is also evidence-gated. A reusable verified skill requires multiple distinct verified task identities, holdout success, and non-stale code anchors where applicable. Repeating one task identity cannot manufacture independent evidence.

## 4. Formal execution model

The operational model is specified in `docs/research/formal-model.md`. The reference state set is:

```text
{ proposed, approved, possibly_committed, executed,
  verified, failed, needs_resolution, rolled_back }
```

The key transition is:

```text
approved/proposed -> possibly_committed -> executed -> verified
```

where `possibly_committed` is persisted before physical dispatch.

The artifact exposes seven paper-facing properties:

- **P1 — no planner risk downgrade**;
- **P2 — high-risk scope narrowing**;
- **P3 — durable ambiguity after possible dispatch**;
- **P4 — verified replay exclusion**;
- **P5 — execution is not verification**;
- **P6 — no blind replay from an ambiguous state**;
- **P7 — independent evidence before trusted reuse**.

The current work is an executable operational model, not a machine-checked proof. A future version may encode the transition system in TLA+, Alloy, Lean, or another model checker.

## 5. Academic artifact

The research branch is intentionally smaller than the product branch. The executable kernel is under `src/`:

- `model.ts` — actions, classes, approvals, ledger entries, evidence, receipts, and memory;
- `policy.ts` — independent risk inference and monotonic effective risk;
- `approval.ts` — bounded approval semantics;
- `ledger.ts` — atomic persistent state transitions;
- `recovery.ts` — observe-before-retry decisions;
- `receipt.ts` — authority-separated receipts;
- `memory.ts` — evidence-gated trusted promotion and staleness;
- `kernel.ts` — composition of the execution protocol.

The product branch uses a richer database-backed implementation and multiple surface adapters. The academic branch deliberately replaces product coupling with a minimal reference schema and atomic JSON persistence. This preserves the research invariants while making the artifact easier to audit.

The artifact can be executed with Node.js 22.6+:

```bash
npm test
npm run bench
```

No third-party runtime packages are required.

## 6. Current artifact validation

### 6.1 Invariant suite

The current artifact contains six executable tests covering:

1. planner risk cannot lower independently inferred risk;
2. high-risk actions cannot use reusable origin scopes;
3. verification requires non-empty independent evidence;
4. ambiguous side effects are not blindly retried;
5. verified action identities cannot dispatch again;
6. trusted skill promotion requires three distinct verified task identities.

The current expected result is `6 passed / 0 failed`.

### 6.2 Synthetic failure-injection sanity check

The deterministic simulator runs 100 trials per strategy over five injected failure modes. Current reference output is:

| Strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

The simulator demonstrates the intended safety/availability trade-off of the state machine. It does **not** establish real-world effectiveness, statistical significance, or benchmark superiority.

## 7. Evaluation plan

The primary experimental design keeps planner, tasks, environment, and budget fixed while changing the execution substrate.

### 7.1 Ablations

At minimum:

1. vanilla tool loop;
2. verifier only;
3. durable ledger only;
4. ledger + verifier;
5. full LHIC-Core.

Additional policy-only and approval-scope ablations can isolate security overhead.

### 7.2 Failure injections

The full evaluation should include:

- crash before dispatch;
- crash after dispatch but before response;
- timeout after effect;
- delayed or stale visibility;
- duplicate response;
- inconclusive observation;
- planner risk understatement;
- expired or replayed approval;
- stale memory;
- concurrent workspace modification.

### 7.3 Metrics

Report task success together with safety and overhead metrics:

- duplicate side effects;
- false success;
- unauthorized actions;
- unsafe replay;
- recovery success;
- `needs_resolution` rate;
- human intervention;
- verifier failure;
- latency overhead;
- added tool calls and tokens.

Repeated trials, confidence intervals, and pass^k-style reliability measures should be used where appropriate.

### 7.4 External validity

Real browser, desktop, and coding adapters are required. OSWorld 2.0 is relevant because its long-horizon workflows expose hidden-state and verification failures. Tau-bench motivates repeated-run reliability and policy-following metrics. SWE-bench-style coding tasks can test file-level side effects, stale state, and objective verification.

Official evaluator output must remain distinct from local preflight or synthetic harness results.

## 8. Related work

**Verified tool calls under non-atomic failures.** Mansoor, Phadke, and Rana (arXiv:2608.02645) directly study timeout-after-dispatch, delayed visibility, postcondition verification, verify-before-retry, and idempotency keys. LHIC-Core therefore does not claim verify-before-retry alone as novel. Its research object is the broader execution contract: persistent ambiguous state, authority-separated receipts, bounded approval, and trusted reuse around the recovery rule.

**Contract-grounded tool execution.** ToolGate (arXiv:2601.04688) uses Hoare-style preconditions and postconditions to gate tool execution and trusted symbolic state updates. LHIC-Core is complementary: it focuses on the case where an external effect may already have committed and must be recovered from durable ambiguity.

**Runtime safety interception.** AgentTrust (arXiv:2605.04785) and ClawGuard (arXiv:2604.11790) demonstrate the importance of intercepting agent actions at the tool boundary. LHIC-Core shares the deterministic runtime boundary but adds a stateful side-effect recovery protocol and evidence-carrying execution history.

**Execution provenance.** Agent-Sentry (arXiv:2603.22868) uses execution traces to learn behavioral bounds. LHIC-Core instead treats provenance as explicit per-action authority and verifier evidence used for recovery and trusted reuse.

**Shared workspace state.** STORM (arXiv:2605.20563) manages multi-agent code state at write time. LHIC-Core should treat workspace conflict awareness as one instance of execution-state mediation, not as its headline novelty.

**Long-horizon benchmarks and memory.** OSWorld 2.0 (arXiv:2606.29537) highlights hidden-state recovery and skipped verification in long workflows. Tau-bench (arXiv:2406.12045) emphasizes repeated-run reliability. Hajimiri et al. (arXiv:2606.15017) show that memory/skill modules do not automatically outperform a budget-matched vanilla actor, motivating explicit reporting of memory overhead and a focus on trust rather than raw memory-enabled success.

## 9. Limitations and threats to validity

The current branch is a reference artifact, not the full product runtime. The synthetic harness is deliberately small. The policy classifier is conservative and incomplete. Atomic JSON persistence is chosen for auditability rather than production throughput. Verifier evidence can itself be wrong. `needs_resolution` improves safety by preserving uncertainty but can reduce availability. Trusted-memory thresholds are design choices that require empirical calibration.

Most importantly, the current artifact does not establish higher planning accuracy or universal agent superiority. The strongest defensible claim is about execution semantics under controlled failures.

## 10. Discussion

LHIC-Core makes a deliberate systems trade-off: it prefers explicit uncertainty to silent replay. In a purely digital benchmark, this can look like lower completion because some ambiguous cases require intervention. In real irreversible workflows, however, a duplicate purchase, duplicate message, destructive write, or credential change can be more costly than a deferred action. Evaluation must therefore report both task completion and irreversible-error rates.

The design also separates model progress from execution reliability. Better planners can be substituted without changing the trust contract. Conversely, the same planner can be compared under different runtime semantics. This separation is useful experimentally and operationally.

## 11. Conclusion

LHIC-Core reframes agent reliability as an execution-systems problem. If planning may be probabilistic, execution truth should still be durable, inspectable, authority-aware, and recoverable. By persisting ambiguous side effects before dispatch, separating execution from verification, enforcing bounded approval, and observing the world before replay, LHIC-Core provides a compact research kernel for safer autonomous agent execution.
