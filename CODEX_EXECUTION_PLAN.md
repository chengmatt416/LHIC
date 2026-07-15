# CODEX_EXECUTION_PLAN.md — Local Human Intent Controller

## Mission

Build a local-first controller that maps user intent to deterministic, verifiable computer actions. The Fast Path uses direct APIs, DOM, accessibility, and keyboard interaction only; it must never use MCP, LLMs, OCR, VLM, or raw coordinate clicks.

## Implemented scope

- Core TypeScript schemas for intent, UI state, actions, verifier conditions, risk, and traces.
- Redacted JSONL trace events, SHA-256 state hashing, risk policy, and credential protection.
- Direct Playwright observation, execution, download watching, DOM/URL/network/file verifiers.
- Local fill-form, download, login, search, and test-web-flow skills.
- Intent parsing, UI stage classification, confidence scoring, action compilation, and Fast/Slow Path routing.
- SQLite-backed skill, selector, and failure/recovery memory.
- Optional disabled-by-default Claude Slow Path provider interface; no provider is part of Fast Path.
- CLI trace inspection and a 50-fixture local internal benchmark.

## Safety invariants

1. Every skill writes redacted trace events.
2. High-risk, unknown-risk, and custom actions require human confirmation.
3. Each successful skill produces verifier evidence; unavailable verification is reported explicitly.
4. Skill promotion requires successful verifier evidence.
5. Secrets, credentials, email addresses, phone-like values, and token-like values are redacted before trace or memory persistence.

## Validation

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run bench:internal
```
