# Related-Work Reference Map

This file is a paper-facing map, not a complete bibliography. It records how LHIC-Core should be positioned against adjacent 2026 work.

## Non-atomic tool calls and verified execution

- **Verified Tool Calls Improve LLM Agent Reliability Under Non-Atomic Failures** studies timeouts after dispatch, delayed visibility, partial updates, postcondition verification, verify-before-retry, and idempotency keys. LHIC-Core is broader: it combines verification with durable side-effect state, authority-separated receipts, approval scopes, and trust-aware learning.
- **ToolGate** frames tool use through preconditions and postconditions. LHIC-Core is complementary: it focuses on side effects that may have already happened and therefore require recovery semantics, not only commit-time symbolic state checks.

## Long-horizon computer use

- **OSWorld 2.0** emphasizes long-horizon realistic computer-use tasks and highlights hidden-state recovery and skipped verification as important failure modes. LHIC-Core should use this as motivation and external validity, not as a source of unsupported SOTA claims.

## Runtime policy and provenance

- Work on runtime interception, policy enforcement, and provenance for agents supports the motivation for separating planner output from execution authority. LHIC-Core's intended novelty is the integrated execution contract: authority-separated receipts + side-effect ledger + verifier-backed recovery.

## Multi-agent state management

- **STORM: Multi-agent Collaboration with State Management** shows that shared-workspace conflict management should occur at write time rather than after-the-fact merge. LHIC-Core can treat workspace conflict awareness as one instance of execution-state mediation rather than as its headline novelty.

## Memory and skill learning

- Agent memory work should be compared carefully. LHIC-Core's memory claim is not that memory always improves raw task success, but that learned behavior should not become trusted automation without verifier-backed, independent, non-stale provenance.

## Claim discipline

Avoid claims such as:

```text
LHIC-Core is the best computer-use agent.
LHIC-Core is a SOTA coding agent.
The synthetic failure harness is an official benchmark.
```

Use precise claims such as:

```text
Under controlled non-atomic failure injection, LHIC-Core reduces duplicate side effects and false completion relative to a vanilla tool loop using the same planner.
```
