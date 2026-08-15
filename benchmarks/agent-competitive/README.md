# Agent competitive benchmark

Reproducible, suite-scoped comparison of LHIC Desktop/omp against Goose and Codex CLI. It is not a general SOTA benchmark.

## Matrix

The immutable fixture set contains 12 tasks: four coding tasks, four local-browser tasks, and four native-desktop tasks. Each product runs every task five times with the same task seed and exact model ID.

Two tracks are reported separately:

- `shared-capability`: only actions all compared products can perform.
- `product-native`: optional product-specific extensions. Never mix this track into the shared-capability claim.

Metrics: independently verified success rate, wall time, turns, human approval count, retry/recovery count, and duplicated verified actions. The verifier is outside every task workspace. Browser and desktop completion is read from the fixture process state; prompts prohibit writing that state directly.

## Pinned products

- LHIC Desktop `0.2.0`, bundled omp `17.2.15`
- Goose `1.46.0`
- Codex CLI `0.147.0`

The runner rejects other Goose/Codex versions. Evidence records SHA-256 digests for the executable, task fixture, fixture set, and output artifact. Install the external tools using their official pinned release instructions; the repository does not install or download them.

Set one exact model for every product:

```sh
export LHIC_BENCH_MODEL_ID='provider/exact-model-id'
```

If a product needs a non-default invocation, provide a JSON argv array. The executable must still report the pinned version from `--version`:

```sh
export LHIC_BENCH_GOOSE_COMMAND_JSON='["/absolute/path/to/goose","run","--text"]'
```

## Run

```sh
npm run bench:agent:self-test
npm run bench:agent:lhic -- --track shared-capability
npm run bench:agent:goose -- --track shared-capability
npm run bench:agent:codex -- --track shared-capability
```

Artifacts are written beneath `benchmarks/agent-competitive/artifacts/` unless `--output` is supplied. Use `--task <id>` and `--repetitions <n>` only for local diagnosis; release evidence requires all 12 tasks and five repetitions.

The `desktop-retry-resume` fixture watches for the first verified native action, kills the descendant omp process, and requires completion after the RPC supervisor restores the session. Repeating that already-verified action fails the duplicate-action invariant.

## Validate and make claims

Combine product runs into one evidence document without changing run records, then validate:

```sh
npm run bench:agent:validate -- path/to/evidence.json goose
npm run bench:agent:validate -- path/to/evidence.json codex
```

A suite-scoped superiority claim is permitted only when:

1. both products cover all 12 tasks with five runs per task;
2. every compared run uses the same exact model ID;
3. LHIC exceeds comparator success by at least 10 percentage points;
4. LHIC median approvals do not exceed the comparator;
5. LHIC duplicates zero verified actions across crash recovery.

`claimAllowed: true` permits only “LHIC beats `<comparator>` on this pinned suite.” `sotaClaimAllowed` is always false. A timeout, crash, denied action, missing tool, missing credential, missing product, or model mismatch remains visible as failed/non-comparable evidence; it is never rewritten as success.

CI runs only `bench:agent:self-test`, fixture schema checks, and evidence-validator tests. Live comparative runs require local credentials and installed pinned products and are intentionally not executed in CI.
