# Action receipts

Every meaningful action — code, shell, browser, desktop, network, control
plane — is represented by an `AgentActionReceipt`
(`lhic-action-receipt-v1`, `packages/schema/src/receipt.ts`).

Authority is explicit per phase and never collapsed:

- **Planner** — `omp` (model) or `lhic`.
- **Approval** — `omp`, `lhic`, `operator`, or `none`; status, scope, action
  hash, approver, and expiry are recorded.
- **Executor** — `omp`, `lhic`, or `external`; backend and fallback chain.
- **Verification** — `lhic`, `external-verifier`, `omp`, or `none`; status
  and evidence refs. OMP-native success is execution evidence, never LHIC
  verification, unless an LHIC/external verifier actually ran.

Persistence: `action_receipt` trace events (redacted, mode 0600), idempotent
per receipt ID, lifecycle-ordered timeline. CLI: `lhic trace provenance
<file> [--json]`. Browser/desktop steps emit receipts with the exact
proposed action, approval hash, executor backend, and verifier evidence
refs; OMP tool events map through `OmpActionReceiptObserver`.
