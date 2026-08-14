# Benchmark methodology

Only evaluator-produced scores count; preflights, self-tests, and LHIC
receipts are never scores. Public bundles are signed manifests
(`lhic-benchmark-evidence-v1`) with pinned LHIC commit, OMP version + SHA,
exact model ID, benchmark/evaluator revisions, and artifact hashes.

Pinned tracks: OSWorld V2 (`osworld-v2-2026.06.24`, fails closed on
revision mismatch), τ³-bench official harness, SWE-bench Verified official
evaluator, digest-pinned AgentLab runner. Bundle layout and commands in
`benchmarks/evidence/README.md`.

Architecture-stress fixtures (13 adversarial scenarios) are deterministic
architecture evidence, not leaderboard results.
