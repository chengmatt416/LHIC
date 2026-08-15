# LHIC-Core: Crash-Consistent, Evidence-Carrying Execution for Autonomous Agents

## Abstract

Autonomous agents increasingly act through browsers, desktops, shell commands, and external tools. These actions are not atomic: a process can crash after dispatch, a UI action can take effect before a response frame is returned, and a timeout can occur after the external state has already changed. Existing agent loops often collapse these cases into a binary tool-call success or failure signal, which can cause duplicate side effects, false success, unsafe replay, or unverified learned behavior.

We present **LHIC-Core**, a local execution kernel that separates planning from execution truth. A planner proposes actions, but LHIC-Core independently classifies risk, enforces bounded approval scopes, persists `possibly_committed` state before external dispatch, verifies postconditions, records authority-separated receipts, and recovers from ambiguous outcomes by re-observing the external world before retrying. The academic artifact extracts these mechanisms from the full LHIC product into a dependency-light reference implementation and a deterministic failure-injection harness. The intended claim is not improved model intelligence, but improved execution semantics: with the same planner, a deterministic runtime can reduce duplicate side effects and false completion under non-atomic failures.

## 1. Introduction

Modern agents are usually evaluated as planners: they observe context, decide on a tool call, receive a result, and continue. This abstraction hides a critical systems problem. In real environments, a tool-call return value is not identical to execution truth. A purchase button may have been clicked before the browser crashed. A file edit may have reached disk while the agent lost its response. A web form may have submitted but only become visible after a delay. A model may label a risky action as harmless because the framework lets the model describe its own intent.

LHIC-Core asks a different question: **what execution substrate should exist underneath a probabilistic planner?** The answer explored here is a crash-consistent, evidence-carrying runtime that treats side effects as durable state transitions rather than ephemeral tool-call returns.

## 2. Problem

We consider an autonomous agent that emits actions against an external environment. The environment may contain non-atomic failure windows:

1. failure before dispatch;
2. failure after dispatch but before response;
3. delayed effect visibility;
4. partial or ambiguous state change;
5. misleading planner-supplied risk labels;
6. stale learned state;
7. concurrent workspace modifications.

A vanilla agent loop commonly retries after failure. This can be correct before dispatch and unsafe after dispatch. The runtime must therefore distinguish **not attempted**, **possibly committed**, **executed**, **verified**, and **needs resolution**.

## 3. LHIC-Core design

LHIC-Core contains six mechanisms.

### 3.1 Independent risk classification

The runtime independently infers a side-effect class from the action surface, tool, intent, target, and origin. A planner-supplied class may increase risk, but never lower the runtime-inferred class.

### 3.2 Bounded approval scopes

Approvals are represented as exact-action, plan-step, read-only-task, or bounded origin/action-class scopes. High-risk actions such as purchase, transfer, credential change, destructive, and admin/security changes cannot use broad reusable scopes.

### 3.3 Durable side-effect ledger

Before external dispatch, LHIC-Core persists an action state of `possibly_committed`. This makes a crash after dispatch recoverable: the system knows the external state may have changed and cannot safely assume failure.

### 3.4 Verify-before-retry recovery

On restart or timeout, LHIC-Core observes the external world. If the effect is present, it verifies and does not replay. If absent, a retry may be admitted by policy. If inconclusive, the action enters `needs_resolution`.

### 3.5 Authority-separated receipts

Each action receipt records planner, approval, execution, and verification authority separately. Executor success does not imply verification. A receipt reaches `verified` only with non-empty verifier evidence.

### 3.6 Trust-aware learning

Learned behavior cannot become trusted automation from a single success. Trusted promotion requires multiple independent verified task identities, holdout success, and non-stale code anchors where applicable.

## 4. Formal model

The formal model is documented in `docs/research/formal-model.md`. The key transition is:

```text
approved/proposed -> possibly_committed -> executed -> verified
```

where `possibly_committed` is persisted before physical dispatch. `verified` is terminal. `needs_resolution` is a safe failure mode: it represents ambiguity rather than silent replay.

## 5. Artifact

The artifact is a minimal TypeScript reference implementation under `src/`:

- `model.ts` defines actions, side-effect classes, approvals, ledger entries, evidence, receipts, and memory records.
- `policy.ts` implements conservative risk inference and the monotonic risk rule.
- `approval.ts` implements bounded scopes and high-risk exclusions.
- `ledger.ts` implements atomic persistent state transitions.
- `recovery.ts` implements observe-before-retry recovery.
- `receipt.ts` constructs authority-separated receipts.
- `memory.ts` implements independent verified promotion and staleness checks.
- `kernel.ts` composes the pieces into a runnable execution kernel.

The artifact can be run with:

```bash
npm test
npm run bench
```

The included benchmark is synthetic and controlled. It is not an official leaderboard result.

## 6. Evaluation plan

The primary evaluation should use ablations:

1. vanilla tool loop;
2. policy-only;
3. verifier-only;
4. ledger-only;
5. ledger + verifier;
6. full LHIC-Core.

Failure modes include crash after dispatch before response, delayed visibility, ambiguous observation, planner risk understatement, approval replay, stale memory, and concurrent workspace conflicts.

Metrics should report task success together with safety metrics:

- duplicate side effects;
- false success;
- unauthorized action;
- unsafe replay;
- recovery success;
- `needs_resolution` rate;
- added latency and tool calls.

The strongest expected result is not necessarily higher raw success. It is fewer irreversible mistakes and fewer false-success states at acceptable overhead.

## 7. Related work positioning

LHIC-Core is adjacent to work on verified tool calls, contract-grounded tool execution, runtime safety enforcement, long-horizon computer-use benchmarks, multi-agent state management, and agent memory. Its intended contribution is the integrated execution contract: durable side-effect semantics plus authority-separated evidence and verify-before-retry recovery.

## 8. Limitations

This branch is a reference artifact, not the full product runtime. The current failure-injection harness is synthetic, so official OSWorld, SWE-bench Verified, and tau-bench-style evaluator output is needed for external validity. The policy classifier is intentionally conservative and minimal. The artifact demonstrates semantics rather than claiming optimal GUI control, coding performance, or model intelligence.

## 9. Conclusion

LHIC-Core reframes agent reliability as an execution-systems problem. If planning may be probabilistic, execution truth should still be deterministic, inspectable, and recoverable. By persisting ambiguous side effects, separating authorities, requiring evidence, and recovering by observation before retry, LHIC-Core provides a research kernel for safer autonomous agent execution.
