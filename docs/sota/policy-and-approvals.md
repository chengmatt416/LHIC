# Policy and approvals

Typed side-effect taxonomy is primary; keyword heuristics are the
conservative backstop. The planner may propose a class, but
`effectiveSideEffectClass` never lowers the independently inferred class;
unknown/unparsed state fails closed to `unknown` risk (never `read`).

Approval scopes (`packages/security/src/approval-scope.ts`):

- `exact_action` / `plan_step` — hash-bound to the action.
- `task_readonly` — read-only classes only, bounded expiry.
- `origin_action_class` — narrow origin + class, expiry and action budget
  enforced via the durable ledger.

High-risk classes (purchase, financial transfer, credential change,
destructive, admin/security) can never use `task_readonly` or
`origin_action_class`. Expiry, hash mutation, replay, homograph origins,
and unknown scope shapes fail closed. Deterministic fuzzing
(`packages/security/src/policy-fuzz.test.ts`, fixed seeds) verifies these
invariants.
