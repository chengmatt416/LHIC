# ComputerIntent — Local Human Intent Controller

> **Convert user intent into deterministic, verifiable computer actions.**

[![CI](https://github.com/chengmatt416/ComputerIntent/actions/workflows/ci.yml/badge.svg)](https://github.com/chengmatt416/ComputerIntent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen)](package.json)

---

## Mission

Build a **local-first** controller that maps human intent to deterministic, verifiable computer actions. The **Fast Path** uses direct APIs, DOM, accessibility, and keyboard interaction only — no MCP, LLMs, OCR, VLM, or raw coordinate clicks. Ambiguous or high-risk tasks fall through to a provider-agnostic **Slow Path**.

---

## Architecture

```
intent → normalized UI state → local prediction → semantic action/skill
  → verifier → redacted trace → skill memory
```

| Package | Role |
|---|---|
| `@lhic/schema` | TypeScript types for intents, actions, UI state, risk, traces |
| `@lhic/browser` | Playwright SDK wrappers — state observation, execution, downloads |
| `@lhic/controller` | Intent parsing, stage classification, confidence scoring, routing |
| `@lhic/memory` | SQLite-backed skill store, selector memory, failure/recovery memory |
| `@lhic/security` | Risk policy, PII redaction, credential guard, runtime config |
| `@lhic/skills` | Deterministic skills: login, search, fill-form, download, test-web-flow |
| `@lhic/trace` | Redacted JSONL event logging, SHA-256 hashing, trace summaries |
| `@lhic/verifier` | Evidence collection: DOM, URL, network, file system |
| `apps/cli` | Command-line interface for running and inspecting actions |

See [docs/architecture.md](docs/architecture.md) for the full architecture walkthrough.

---

## Quick Start

### Prerequisites

- **Node.js** >= 24.0.0 < 25 (required for `node:sqlite`)
- **npm** >= 11.0.0

### Setup

```bash
# Clone and install
git clone https://github.com/chengmatt416/ComputerIntent.git
cd ComputerIntent
npm ci

# Install Playwright browser
npm run pw:install

# Run the full CI pipeline
npm run ci
```

### CLI Usage

```bash
# Run a preflight check
npm run preflight

# Run the internal benchmark
npm run bench:internal

# Inspect trace files
npm run trace:inspect
```

---

## Key Design Principles

1. **Fast Path must not call LLMs or use MCP** — deterministic, low-latency execution.
2. **Prefer API / DOM / Accessibility / OS automation** over OCR, VLM, or raw coordinates.
3. **Every action needs verifier evidence** — skills are only promoted with proof of success.
4. **Never log credentials or unredacted PII** — redaction is defense-in-depth.
5. **High-risk tasks require human confirmation** — with optional Ed25519-signed approval in production.

---

## Repository Structure

```
ComputerIntent/
├── apps/
│   └── cli/              # CLI application
├── benchmarks/           # Internal regression & external benchmark protocol
│   ├── agentlab/         # AgentLab-compatible benchmark runner
│   └── README.md         # External benchmark evidence protocol
├── docs/
│   ├── architecture.md   # Architecture overview
│   ├── security.md       # Security controls and invariants
│   ├── production-readiness.md
│   ├── market-position.md
│   ├── market-research.md
│   ├── benchmark.md
│   ├── cowork-comparison.md
│   └── advantage-simulation.md
├── packages/
│   ├── browser/          # Playwright SDK wrappers
│   ├── controller/       # Intent parsing, classification, routing
│   ├── memory/           # SQLite-backed persistence
│   ├── schema/           # Core TypeScript type definitions
│   ├── security/         # Risk policy, redaction, config
│   ├── skills/           # Deterministic action skills
│   ├── trace/            # Redacted event logging
│   └── verifier/         # Evidence collection engine
├── tests/                # Integration tests
├── AGENTS.md             # Agent development guide & handoff format
├── CODEX_EXECUTION_PLAN.md
├── Dockerfile            # Production container image
└── package.json          # Monorepo root
```

---

## Validation Commands

```bash
npm run typecheck       # TypeScript type checking
npm test                # Run test suite (vitest)
npm run lint            # ESLint
npm run format:check    # Prettier formatting check
npm run build           # Compile TypeScript
npm run bench:internal  # Local regression benchmark
npm run preflight       # Production-readiness preflight check
npm run audit:prod      # Production dependency audit
```

---

## Security

The controller includes multiple defense-in-depth controls:

- **PII redaction** — credentials, tokens, emails, and phone-like values are redacted before trace or memory writes.
- **Risk policy** — high-risk, unknown-risk, and custom actions require human confirmation.
- **Production origin allowlist** — HTTPS-only navigation, no private-network targets.
- **Verifier evidence** — every successful skill must produce proof; unavailable verification is reported as a gap.
- **Approval signing (production)** — high-risk actions require Ed25519-signed approval artifacts.

See [docs/security.md](docs/security.md) for the full security policy.

---

## Production

Build and run the container:

```bash
docker build --tag lhic:local .
docker run --rm \
  -e LHIC_ALLOWED_ORIGINS=https://app.example.com \
  -v lhic-traces:/var/lib/lhic/traces \
  lhic:local preflight
```

See [docs/production-readiness.md](docs/production-readiness.md) for detailed operational requirements.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for development guidelines, task handoff format, and validation commands.

---

## License

MIT — see [LICENSE](LICENSE) for details.
