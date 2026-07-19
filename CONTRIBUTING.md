# Contributing to LHIC

Thanks for helping improve the Local Human Intent Controller. Changes should
preserve the local-first safety boundary and remain small enough to review.

## Before opening a change

1. Read [the architecture](docs/architecture.md), [security policy](docs/security.md),
   and [production readiness guide](docs/production-readiness.md).
2. Explain the user-visible behavior, threat model impact, and any new
   runtime dependency in the pull request description.
3. Add focused tests for changed behavior and avoid real credentials,
   external accounts, or unredacted PII in fixtures.

## Local validation

Use Node.js 24 and the repository's npm lockfile:

```bash
npm ci
npm run pw:install
npm run format:check
npm run typecheck
npm test
npm run lint
npm run build
npm run preflight
```

Python changes should also run the AgentLab unit tests and the game worker
smoke test listed in `.github/workflows/ci.yml`.

## Design rules

- Fast Path must not call an LLM or MCP; use Playwright/CDP and semantic DOM
  or accessibility targets.
- Every action needs approval when required by risk policy and every task
  needs verifier evidence and redacted trace events.
- Fail closed on ambiguous targets, missing evidence, invalid schemas,
  expired leases, and unsafe paths.
- Do not add a dependency without documenting why the existing runtime or
  standard library is insufficient.

Pull requests should describe verification results and known limitations.
