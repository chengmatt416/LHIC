# Codex collaboration

The project maintainer conceived LHIC, set product direction, defined the
architecture and threat model, reviewed implementation choices, and accepted
the final engineering and release decisions. Codex accelerated implementation,
test creation, debugging, refactoring, benchmark tooling, and documentation.

## Project-wide division of labor

Codex was used as the engineering collaborator across the project lifecycle:

- **Architecture and contracts:** translating the local-first mission into
  typed schemas, Fast Path/Slow Path routing, policy boundaries, verifier
  evidence, redacted traces, and human approval checkpoints.
- **Runtime implementation:** building and refining the Playwright browser
  executor, semantic skills, controller/provider boundary, desktop Control
  Center, MCP integration, shared-skill registry, memory, security controls,
  and local game-training paths.
- **Verification and resilience:** adding unit, integration, browser, package
  smoke, benchmark, secret-scan, release, and documentation checks; then using
  failures and review findings to drive focused fixes.
- **Product and submission material:** preparing the README, architecture and
  security guides, demo director and judge instructions, benchmark methodology,
  release notes, and the Build Week commit map.

GPT-5.6 was used as the product's optional **Slow Path** model integration. It
does not author or directly execute arbitrary computer actions. Its role is to
interpret ambiguous browser state and propose a constrained semantic action or
plan. The controller redacts the request, the provider requires strict
structured output, LHIC validates the returned action against its own schema,
and the executor still applies risk policy, human approval, local execution,
and post-action verification. This makes the model a bounded source of
planning assistance while keeping control and evidence in LHIC.

The distinction is intentional: Codex helped build and verify the system;
GPT-5.6 is an optional capability exercised by the system at runtime. Fast Path
browser execution, controlled benchmark baselines, and local game training do
not call GPT-5.6 or MCP.

## Evidence in this repository

- The Build Week commit mapping is in [build-week-changelog.md](build-week-changelog.md).
- Controller, browser, verifier, security, memory, and CLI tests demonstrate
  iterative implementation rather than a documentation-only contribution.
- The safe demo and GPT-5.6 provider tests make the current release candidate
  reproducible without exposing credentials.

## Submission requirement

Before submitting, add the official `/feedback` Session ID for the primary
Codex development thread to the Devpost entry and the release evidence. Do not
substitute a guessed thread ID or a documentation-only session. Keep the
decision record: important accepted, modified, and rejected suggestions should
be traceable to commits, tests, or review notes.
