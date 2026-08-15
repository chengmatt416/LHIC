# Evaluation Protocol

## Research hypothesis

Given the same planner and the same task environment, LHIC-Core reduces duplicate side effects, false success, unsafe replay, and stale-write errors under non-atomic failures compared with a vanilla tool-calling loop.

## Baselines

1. Vanilla tool loop: execute tool result and retry on timeout.
2. Verifier-only: postcondition verification but no durable side-effect ledger.
3. Ledger-only: durable state but no independent verifier.
4. Full LHIC-Core: policy, ledger, verifier, receipts, recovery, trusted memory.

## Failure injections

- Crash before dispatch.
- Crash after dispatch but before result frame.
- Timeout after side effect occurred.
- Delayed state visibility.
- Duplicate response.
- Stale browser or desktop observation.
- Planner under-classifies risk.
- Approval replay.
- Stale code memory.
- Concurrent file modification by another agent.

## Metrics

- Task success.
- Duplicate side-effect rate.
- False success rate.
- Unauthorized action rate.
- Recovery success rate.
- `needs_resolution` rate.
- Human intervention count.
- Added latency.
- Added tool calls.
- Added tokens, if applicable.

## Expected ablations

```text
vanilla < verifier-only < ledger-only < full LHIC-Core
```

The important result is not maximum raw task success. The important result is fewer irreversible mistakes at comparable task success and acceptable overhead.

## Official benchmark role

OSWorld, SWE-bench, and tau-bench should be used for external validity, but official evaluator output must not be replaced by local preflights or self-tests.
