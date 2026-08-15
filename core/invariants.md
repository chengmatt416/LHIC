# LHIC-Core Invariants

## I1. Execution is not verification

An executor returning success does not imply postcondition verification. A receipt may say `executionAuthority = omp` and `verificationAuthority = none`.

## I2. Planner risk cannot lower runtime risk

A planner-provided side-effect class may increase risk but cannot reduce the independently inferred side-effect class.

## I3. Ambiguous side effects are not blindly retried

If a process crashes or times out after dispatch may have occurred, recovery must re-observe state before retry. If the outcome cannot be determined, the action enters `needs_resolution`.

## I4. Verified effects are not replayed

Once an action reaches `verified`, restart or replay cannot dispatch it again under the same action identity.

## I5. Approval is scope-bound

Approval must bind to action hash, plan step, read-only task scope, or a narrow origin/class/action-count scope. Broad mutation approval for an entire session is invalid.

## I6. High-risk actions require exact approval

Purchase, financial transfer, credential change, destructive, and admin/security actions cannot inherit broad reusable scopes.

## I7. Evidence must be non-empty

A verifier result without evidence cannot promote a receipt to `verified`.

## I8. Learned behavior requires evidence and independence

A reusable skill or recipe cannot be promoted from one success or repeated executions of the same task identity.

## I9. Stale code memory is not current truth

Code-derived memory must be anchored to file hashes or symbols; changed anchors reduce confidence or mark the record stale.

## I10. Concurrent writes require state mediation

If an agent writes a file that another active agent read at an older hash, the stale reader must be notified before its next write.
