# Side-effect recovery

`@lhic/ledger` is a durable SQLite state machine
(`lhic-side-effect-ledger-v1`) over browser/desktop/network/control-plane
side effects. Transitions are atomic; `possibly_committed` is written
BEFORE the physical dispatch, so a crash mid-dispatch leaves an ambiguous,
re-observable state.

Recovery rules:

- `verified` — never repeat.
- `executed` (unverified) — re-observe the postcondition before any retry.
- `dispatching` / `possibly_committed` — assume ambiguous: inspect external
  state, verify whether the side effect happened, retry only when evidence
  says it did not, otherwise mark `needs_resolution`.
- `approved` — revalidate hash, scope, expiry, current target.
- `proposed` — may re-plan.

Kill-injection tests cover crash after physical effect (verified, no
duplicate), crash before provable effect (needs_resolution, no blind
replay), verified-never-repeats, and task isolation. Scope usage counters
for `origin_action_class` approvals live in the same database.
