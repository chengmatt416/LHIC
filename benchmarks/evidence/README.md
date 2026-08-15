# Benchmark Evidence Bundles

Public benchmark evidence is a signed, pinned bundle — never a self-test or a
preflight. A bundle proves "we ran this exact stack" and can be independently
validated.

## Bundle layout

```text
benchmarks/evidence/<benchmark>/<timestamp-or-release>/
  manifest.json        lhic-benchmark-evidence-v1 (signed)
  run-config.json      normalized CLI invocation / config
  environment.json     OS, arch, runtime, env capture (no secrets)
  evaluator/           official evaluator-produced raw output
  results/             task results
  logs/                bounded runner logs
  hashes.sha256        artifact digests
  README.md            how this run was produced
```

## Required identities (no floating refs)

- `lhicCommit` — exact LHIC commit SHA.
- `ompVersion` + `ompSha256` — exact OMP version and trusted executable
  digest (measured, never self-derived).
- `modelId` — exact provider/model ID.
- `benchmark` + `benchmarkRevision` — official benchmark repo/tag.
- `evaluatorRevision` — official evaluator repo/tag.
- `fixtureOrDatasetSha256` / `runnerSha256` / `configurationSha256`.

## Pinned official tracks

- **OSWorld V2** — `LHIC_OSWORLD_BENCHMARK_REVISION=osworld-v2-2026.06.24`
  (see `benchmarks/osworld/README.md`; the bridge fails closed on revision
  mismatch).
- **τ³-bench / tau3** — Sierra Research official harness; pin the repository
  revision in `benchmarks/tau/run_tau3.py` before any public run.
- **SWE-bench Verified** — official evaluator/harness with the exact Verified
  task set revision.
- **AgentLab / WorkArena** — digest-pinned runner image
  (`benchmarks/agentlab/Dockerfile`).

## Signing and validation

```bash
# sign a manifest (Ed25519 key)
lhic bench evidence-sign manifest.json --key signing-key.pem --key-id k1

# validate a bundle (artifact hashes + optional signature)
lhic bench evidence-validate manifest.json --artifacts <bundle-dir> \
  --public-key public-key.pem
```

An unsigned bundle is usable locally but must be labeled unsigned; a public
claim bundle must not silently drop signature failure. A mutated artifact or
executable fails validation. Only evaluator-produced scores count — adapter
preflights, fixture completion, and LHIC receipts are never scores.
