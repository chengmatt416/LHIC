# Market-position gate

## Current status

The product has a differentiated architecture for deterministic browser workflows: direct Playwright execution, verifier evidence, redacted traces, local skill memory, and executor-level approval enforcement. This is a product hypothesis, **not** a market SOTA claim.

The internal 50-fixture score measures regression resistance only. It is intentionally excluded from external performance comparisons.

The controlled selector-resilience simulation reports a large improvement over a deliberately limited fixed-selector ablation. It is a useful engineering signal, not an external-agent score; see [market research and benchmark strategy](market-research.md).

## What qualifies as a defensible SOTA statement

All of the following must be true for the exact benchmark/version being named:

1. A full, unmodified external suite has been run with a pinned benchmark commit, container digest, seed, command, and immutable result artifact.
2. The candidate score exceeds the latest recorded public comparator for the same suite and protocol.
3. An independent party reproduces the result from the public artifact.
4. The production deployment passes CI and production preflight, and has no unresolved critical security finding.
5. The claim is scoped precisely (for example, "highest reproducible score on WorkArena version X under protocol Y"), dated, and removed when the comparator changes.

The CLI can validate evidence completeness with:

```bash
lhic bench validate-evidence evidence.json
```

It deliberately returns `sotaClaimAllowed: false`; software running locally cannot independently establish a market position. See [the external benchmark protocol](../benchmarks/README.md) for the evidence format.

## Benchmark sources

- [BrowserGym](https://github.com/ServiceNow/BrowserGym) provides a unified environment for web-agent benchmarks.
- [WorkArena](https://github.com/ServiceNow/WorkArena) provides reproducible knowledge-work browser tasks.
- [AgentLab](https://github.com/ServiceNow/AgentLab) provides scalable experiment/leaderboard tooling for browser-agent evaluations.

These are evaluation infrastructure, not endorsements or evidence that this project currently leads any leaderboard.
