# Paired No-Fault Reference-Artifact Overhead

This microbenchmark measures the cost of the **academic reference implementation** under a no-fault local code action. It is designed to decompose execution-boundary costs; it is not a production LHIC latency claim.

## Validated run

- implementation commit: `dccaf0505aa79850687e10516336b746a69515bc`
- workflow: `Academic Artifact`
- workflow run: `31881515546`
- artifact: `9246140145`
- artifact digest: `sha256:70f16517cc9d9a447c29d6bcd2c294aabcb14b53bdea4ea6ef5c609af6d86690`
- environment: Ubuntu 24.04 / Linux x64 / Node.js v22.23.2
- trials per variant: 80
- persistence: atomic-JSON academic reference ledger

## Variants

1. `direct_execute`
   - write one local marker file;
   - no ledger;
   - no verification.

2. `direct_execute_verify`
   - write the same marker;
   - read it back and verify exact content;
   - no durable LHIC ledger.

3. `split_boundary`
   - create/load academic ledger;
   - exact-action approval;
   - persist `possibly_committed` before write;
   - write the marker;
   - record executor response as `executed`;
   - no independent verifier.

4. `full_kernel`
   - policy + exact approval;
   - durable pre-dispatch ambiguity;
   - marker write;
   - independent read-back verifier;
   - transition to `verified`.

Variants are interleaved per trial to reduce systematic temporal bias. One warm-up per variant is excluded from timing.

## Results

| Variant | Trials | Mean | Median | p95 | Min | Max |
|---|---:|---:|---:|---:|---:|---:|
| Direct execute | 80 | 0.258 ms | 0.182 ms | 0.291 ms | 0.138 ms | 3.019 ms |
| Direct execute + verify | 80 | 0.406 ms | 0.367 ms | 0.553 ms | 0.266 ms | 3.304 ms |
| Split durable boundary | 80 | 1.494 ms | 1.506 ms | 1.777 ms | 1.117 ms | 2.408 ms |
| Full LHIC-Core | 80 | 2.157 ms | 2.108 ms | 2.667 ms | 1.576 ms | 5.103 ms |

Derived median differences:

```text
split boundary - direct execute       = +1.324 ms
full kernel - direct execute + verify = +1.741 ms
```

The raw ratio between full-kernel median and direct-write median is about 11.6x, but that ratio is not a useful production claim because the baseline operation itself is sub-millisecond and the reference ledger deliberately performs synchronous atomic JSON persistence.

## Interpretation

The useful result is not “LHIC adds 2 ms everywhere.” The useful result is that, in this small reference-artifact microbenchmark, the deterministic trust machinery has a millisecond-scale local cost that can be decomposed into persistence and verification work.

A browser, desktop, network, or remote API action is normally much more expensive than this local marker write, while a production database-backed ledger has different persistence characteristics from the academic JSON implementation. Therefore these numbers should remain artifact-scoped.

## Claim boundary

Allowed:

> On the academic atomic-JSON reference artifact, 80 paired local no-fault trials produced a median of 1.506 ms for the split durable boundary and 2.108 ms for the full kernel, compared with 0.182 ms for a direct write and 0.367 ms for direct write plus read-back verification.

Not allowed:

- “LHIC adds only 2 ms in production.”
- “LHIC overhead is negligible on OSWorld.”
- extrapolating this result to remote APIs, browser actions, OMP, or the product SQLite implementation.

## Next overhead experiment

Publication-facing overhead should measure paired end-to-end actions on the same real surfaces used for fault injection:

- Browser: direct form submission vs boundary vs boundary+verification.
- Desktop: direct X11 click vs boundary vs boundary+verification.
- Code: real Git action vs boundary vs boundary+verification.

Report both absolute end-to-end latency and incremental LHIC work, with confidence intervals over repeated trials.
