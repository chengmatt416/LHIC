# Judge guide

## 60-second safe path

Requirements: Node.js 24, installed Playwright Chromium, and no account or API
key.

```bash
npm ci
npm run pw:install
npm run demo -- --safe
```

Expected result: JSON reports `passed: true`, a verified local browser fixture,
an `ask_user` result for a destructive intent, and GPT-5.6 as disabled unless
the optional Slow Path environment variables were supplied. The fixture uses no
network target, customer account, or real credential.

The repository CI repeats the equivalent packaged tarball demo on Ubuntu,
macOS, and Windows. It verifies a package build rather than a released npm
version; check the release evidence before substituting the `npx` command.

## Extended verification

```bash
npm run typecheck
npm test
npm run bench:internal
npm run bench:simulate
npm run preflight
npm run package:smoke
```

The internal benchmark and selector-resilience simulation are controlled local
engineering measurements, not external leaderboard claims. Read
[benchmark methodology](benchmark-methodology.md) before quoting a result.

## GPT-5.6 path

With an OpenAI API key in the process environment, run:

```bash
OPENAI_SLOW_PATH_ENABLED=true OPENAI_API_KEY=... npm run demo
```

The Demo then asks GPT-5.6 for a strictly structured, redacted Slow Path plan.
It does not execute a model proposal automatically; policy, verification, and
the approval boundary remain LHIC responsibilities.

## What to inspect

- `packages/controller/src/openai-provider.ts` for GPT-5.6's typed boundary.
- `packages/browser` and `packages/skills` for direct Playwright Fast Path.
- `packages/security` and `packages/trace` for approval and redaction.
- `packages/verifier` for post-action evidence.
- `docs/build-week-changelog.md` for dated Build Week evidence.

See [troubleshooting](troubleshooting.md) if Chromium or Node setup fails.
