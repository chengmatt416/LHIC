# Related-Work Reference Map

This file is a paper-facing positioning map, not a complete bibliography. It records the closest primary sources and the novelty boundary LHIC-Core should preserve.

## 1. Non-atomic tool calls and verified execution

### Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures

- Mansoor, Phadke, Rana (2026)
- arXiv:2608.02645
- Studies timeout-after-dispatch, delayed visibility, partial updates, postcondition verification, verify-before-retry, and idempotency keys.

**Implication for LHIC-Core:** verify-before-retry by itself is not a sufficient novelty claim. LHIC-Core should emphasize persistent pre-dispatch ambiguity state, authority-separated receipts, bounded approval, cross-surface recovery, and trust-aware reuse around that recovery rule.

### ToolGate: Contract-Grounded and Verified Tool Execution for LLMs

- Liu et al. (2026)
- arXiv:2601.04688
- Uses Hoare-style preconditions and postconditions to gate tool execution and verified symbolic-state updates.

**Implication for LHIC-Core:** contract verification is adjacent. LHIC-Core focuses on the additional systems problem where an external side effect may already have committed before the runtime receives a trustworthy result.

## 2. Runtime policy and security boundaries

### AgentTrust: Runtime Safety Evaluation and Interception for AI Agent Tool Use

- Yang (2026)
- arXiv:2605.04785
- Runtime interception with structured allow/warn/block/review decisions across risky tool use.

### ClawGuard: A Runtime Security Framework for Tool-Augmented LLM Agents Against Indirect Prompt Injection

- Zhao, Li, Zhang, Sun (2026)
- arXiv:2604.11790
- Deterministic rule enforcement at the tool-call boundary against indirect prompt injection.

**Implication for LHIC-Core:** runtime policy interception is a crowded research area. Policy should support the paper's execution semantics, not be claimed as the standalone novelty.

## 3. Execution provenance

### Agent-Sentry: Bounding LLM Agents via Execution Provenance

- Sequeira et al. (2026)
- arXiv:2603.22868
- Uses execution traces to construct behavioral bounds and block out-of-bounds actions.

**Implication for LHIC-Core:** provenance alone is not novel. The LHIC-specific claim is authority-aware, evidence-carrying provenance used as execution truth for verification, recovery, and trusted reuse.

## 4. Long-horizon computer use

### OSWorld2.0: Benchmarking Computer Use Agents on Long-Horizon Real-World Tasks

- Yuan et al. (2026)
- arXiv:2606.29537
- 108 long-horizon workflows; emphasizes hidden state, constraint tracking, and verification failures.

**Implication for LHIC-Core:** strong motivation and external-validity target. Do not substitute local or synthetic tests for official OSWorld evaluator output.

### tau-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains

- Yao, Shinn, Razavi, Narasimhan (2024)
- arXiv:2406.12045
- Evaluates tool-agent-user interaction and introduces pass^k-style repeated-run reliability.

**Implication for LHIC-Core:** repeated-trial reliability should be reported in addition to single-run success.

## 5. Multi-agent workspace state

### Multi-agent Collaboration with State Management (STORM)

- Liu, Chen, Xu, Jiang, Dong (2026)
- arXiv:2605.20563
- Mediates shared-workspace state and conflicts at write time rather than deferring conflict resolution to merge time.

**Implication for LHIC-Core:** workspace conflict awareness should be positioned as one instance of external-state mediation, not the headline novelty.

## 6. Memory and skill learning

### Are Online Skill and Memory Modules Always Worth Their Tokens? A Budget-Constrained Study of Web Agents

- Hajimiri et al. (2026)
- arXiv:2606.15017
- Shows that memory/skill augmentation can lose to a budget-matched vanilla actor and emphasizes run-to-run variance and token cost.

**Implication for LHIC-Core:** the memory claim should be about trustworthy promotion and provenance, not that memory necessarily increases raw task success. Overhead must be reported.

## 7. Claim discipline

Avoid claims such as:

```text
LHIC-Core is the best computer-use agent.
LHIC-Core is a SOTA coding agent.
Verify-before-retry is unique to LHIC-Core.
The synthetic failure harness is an official benchmark.
```

Use claims such as:

```text
LHIC-Core integrates durable ambiguous side-effect state, authority-separated
receipts, bounded approval, independent verification, and observe-before-retry
recovery into a compact execution kernel.
```

and, once backed by repeated experiments:

```text
Under controlled non-atomic failure injection with the planner held fixed,
LHIC-Core reduced duplicate side effects and unsafe replay relative to the
specified runtime baselines at the reported completion/intervention overhead.
```
