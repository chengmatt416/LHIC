# Changelog

All notable changes to ComputerIntent are documented in this file.

## [0.1.0] — 2026-07-15

### Added

- **Core TypeScript schemas** — intents, UI state, actions, verifier conditions, risk levels, and traces.
- **Security infrastructure** — PII redaction, credential guard, risk policy, runtime configuration, and Ed25519 action-approval verification.
- **Playwright browser integration** — state observation, direct execution, download watching, target resolution.
- **Verifier engine** — DOM, URL, network, and file-system evidence collection.
- **Deterministic skills** — `login`, `search`, `fill-form`, `download-file`, and `test-web-flow`, each with verifier-backed results.
- **Controller** — intent parsing, UI stage classification, confidence scoring, action compilation, and Fast/Slow Path routing.
- **Memory** — SQLite-backed skill store (with draft→verified→habit→trusted lifecycle), selector memory, and failure/recovery memory.
- **Trace system** — redacted JSONL event logging, SHA-256 state hashing, and trace summary with risk distribution.
- **CLI** — action execution, preflight checks, trace inspection, and internal benchmark.
- **CI pipeline** — GitHub Actions workflow running type checks, tests, linting, formatting, build, benchmark, preflight, and audit.
- **Dockerfile** — production container with non-root user, Playwright Chromium, and configurable runtime controls.
- **Benchmark infrastructure** — internal regression suite and external benchmark protocol (WorkArena/WebArena through AgentLab).
- **Documentation** — architecture, security, production-readiness, market position, and advantage simulation docs.
