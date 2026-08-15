# Formal Model

This document defines the paper-facing LHIC-Core execution model. It is intentionally small enough to audit and implement in `src/`.

## Entities

An **action** is a tuple:

```text
a = (actionId, taskId, surface, tool, intent, target, origin, actionHash, plannerClass?)
```

A **side-effect class** is one of:

```text
read, local_edit, local_execute, download, upload, external_write,
message_send, account_change, purchase, financial_transfer,
credential_change, destructive, admin_or_security_change, unknown
```

A **ledger entry** is:

```text
l = (actionId, actionHash, taskId, surface, sideEffectClass, state, evidenceIds)
```

where:

```text
state ∈ { proposed, approved, possibly_committed, executed,
          verified, failed, needs_resolution, rolled_back }
```

A **receipt** records the authorities involved in one action:

```text
r = (plannerAuthority, approvalAuthority, executionAuthority,
     verificationAuthority, ledgerState, evidence)
```

## Risk rule

LHIC-Core computes an independent class `c_i = infer(a)`. A planner may also supply `c_p`.

The effective class is:

```text
effective(a) = max_rank(c_i, c_p)
```

If `c_p` is absent, `effective(a) = c_i`.

**Invariant:** the planner can increase effective risk but cannot reduce the independently inferred risk.

## Approval rule

An approval is valid only if it satisfies one of the supported bounded scopes:

```text
exact_action(actionHash)
plan_step(planId, stepId, actionHash)
task_readonly(taskId, expiresAt)
origin_action_class(origin, class, expiresAt, maxActions)
```

High-risk classes:

```text
purchase, financial_transfer, credential_change,
destructive, admin_or_security_change
```

cannot be covered by `task_readonly` or `origin_action_class` scopes.

## Execution state machine

The minimal transition relation is:

```text
proposed -> approved | possibly_committed | failed | needs_resolution
approved -> possibly_committed | failed | needs_resolution
possibly_committed -> executed | verified | needs_resolution | failed
executed -> verified | needs_resolution | failed
verified -> terminal
failed -> terminal
needs_resolution -> executed | verified | rolled_back
rolled_back -> terminal
```

The critical transition is:

```text
approved/proposed -> possibly_committed
```

which must be persisted **before** external dispatch. This records that an external effect may happen even if the process later crashes or loses the response.

## Verification rule

A receipt may enter `verified` only when:

```text
verifier result = passed
AND evidence artifact list is non-empty
```

Executor success alone is not verification.

## Recovery rule

For an entry in `possibly_committed` or `executed`, recovery consults the external observation:

```text
observe(a) = effect_present      -> verify; do not replay
observe(a) = effect_absent       -> safe retry path may be admitted by policy
observe(a) = inconclusive        -> needs_resolution
```

A `verified` entry is terminal and cannot dispatch again under the same action identity.

## Learning rule

A behavior may be promoted to trusted reusable state only if:

1. all supporting receipts are verified;
2. the receipts come from at least three distinct task identities;
3. the holdout condition passed;
4. code anchors, if any, are not stale.

This prevents one lucky run or one repeated task from becoming a trusted automation.
