# Ablation Matrix

The academic artifact should be evaluated by disabling runtime mechanisms while keeping the planner, tasks, and environment fixed.

## Systems compared

| Variant | Policy | Approval scope | Durable ledger | Verifier | Observe-before-retry | Receipts | Trusted memory |
|---|---:|---:|---:|---:|---:|---:|---:|
| Vanilla tool loop | no | no | no | no | no | no | no |
| Policy-only | yes | yes | no | no | no | partial | no |
| Verifier-only | no | no | no | yes | no | partial | no |
| Ledger-only | no | no | yes | no | limited | partial | no |
| Ledger + verifier | no | no | yes | yes | yes | partial | no |
| Full LHIC-Core | yes | yes | yes | yes | yes | yes | yes |

## Failure modes

| Failure mode | Expected vanilla behavior | Expected full LHIC-Core behavior |
|---|---|---|
| Crash before dispatch | May retry; usually safe by accident | Ledger indicates no possible commit or admits safe retry after observation |
| Crash after dispatch before response | Often retries and duplicates effect | Observes external state before replay; does not duplicate if effect exists |
| Timeout after effect | Treats timeout as failure | Treats timeout as ambiguous external state |
| Delayed visibility | May retry too early | Can enter needs_resolution or wait/re-observe depending on verifier policy |
| Planner understates risk | Trusts model label if framework has no independent policy | Independent classifier prevents risk lowering |
| Approval replay | May reuse stale human consent | Action hash / scope / expiry gates reject invalid replay |
| Empty verifier evidence | May call success from executor status | Cannot mark verified without non-empty evidence |
| Stale memory | Reuses stale learned text | Trust/staleness gates prevent Fast Path promotion or mark memory stale |

## Metrics

Report both success and safety metrics:

- task success rate;
- duplicate side effects per trial;
- false success rate;
- unauthorized action rate;
- unsafe replay rate;
- needs_resolution rate;
- human intervention rate;
- verifier failure rate;
- median added latency;
- added tool calls / tokens where available.

## Interpretation

A good result is not simply higher task success. The primary academic claim is that full LHIC-Core reduces irreversible mistakes and false completion under non-atomic failure conditions at acceptable overhead.

Synthetic failure-injection results are internal validity evidence. OSWorld, SWE-bench Verified, and tau-bench style evaluators should be used only as external validity once official harness outputs are available.
