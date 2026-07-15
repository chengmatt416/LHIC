# External benchmark protocol

The internal benchmark is a regression/smoke suite. Its score is **not** comparable to the web-agent market and must never be used in a SOTA claim.

The external gate uses BrowserGym/AgentLab-compatible benchmarks. Start with WorkArena for deterministic enterprise workflows and WebArena for broader multi-site tasks. Run the complete published suite, not a hand-picked subset, in a pinned container with a fixed benchmark commit and seed.

## Required evidence

1. Publish the unmodified benchmark commit, container digest, launch command, seed, and complete result artifact.
2. Record the current public comparator source and its observation date before running the candidate.
3. Supply the artifact to `lhic bench validate-evidence evidence.json`.
4. Arrange an independent reproduction. Local validation will deliberately never authorize a SOTA claim.

The evidence JSON fields are validated by the CLI. A result is reviewable only when it is a full-suite run, beats the recorded comparator, and includes immutable runner/artifact identifiers. A market SOTA statement additionally requires a public, independently reproduced result and product adoption evidence.

## Recommended progression

Begin with a single WorkArena L1 debug task through an AgentLab-compatible adapter, then run the unmodified complete L1 suite with fixed reproducibility settings. Do not use the local selector-resilience ablation as a public comparator or submission artifact; its fixed-selector treatment is intentionally narrow. The decision framework is in [market research and benchmark strategy](../docs/market-research.md).

Use `lhic bench readiness workarena` or `lhic bench readiness webarena` to identify missing local prerequisites. A passing readiness check only proves that the local runner can be configured; it does not authorise submission.

For a host-independent Python 3.12 AgentLab/Chromium preflight image, see [the AgentLab runner](agentlab/README.md). It establishes runner readiness only; it does not supply the required LHIC AgentLab adapter.

## Release bar

- WorkArena: full published suite, fixed seed, verifier-backed action traces.
- WebArena: full published suite, fixed seed, no hidden task-specific selectors.
- Production: all CI gates pass, `LHIC_ENV=production` has an HTTPS origin allowlist, and high-risk actions have human approvals.
