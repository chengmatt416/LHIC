# Reproducibility

## Supported runtime

- Node.js 24.x (required by `node:sqlite`)
- macOS, Windows, or Linux for browser workflows
- Playwright Chromium for the local demo and browser tests

Global desktop controls use native OS APIs and have additional setup and
permission requirements described in [global control](global-control.md).

## Clean local checkout

```bash
npm ci
npm run pw:install
npm run typecheck
npm test
npm run demo -- --safe
npm run bench:internal
npm run package:smoke
npm run check:docs
npm run scan:secrets
```

The safe demo needs no API key. To test optional GPT-5.6 planning, set
`OPENAI_SLOW_PATH_ENABLED=true` and `OPENAI_API_KEY` in the shell only. Never
write the key to a file or include it in test fixtures.

## Package smoke test

GitHub Actions runs the tarball equivalent of the published package on Ubuntu,
macOS, and Windows for every pull request and push to `main`. Each job packs
the CLI, installs it in a new temporary directory, installs that package's
Chromium, and requires `lhic demo --safe` to report `passed: true` with the GPT Slow
Path disabled. This is cross-platform package evidence, not evidence that a
specific npm publication is available.

Run the same check locally with `npm run package:smoke`. It removes OpenAI API
key environment variables from the spawned demo process, so this check cannot
make a model request or write a credential to its output.

## Repository hygiene gates

`npm run check:docs` checks tracked Markdown links that point to local files.
`npm run scan:secrets` scans every reachable Git commit for high-confidence
credential formats and never prints a matched value. It is a local guardrail,
not a replacement for the code-host secret scanner or a credential rotation
process.

## Evidence to record before submission

The registry's `@pinyencheng/lhic@0.1.1` release predates the current demo and
does not support `lhic demo`. After publishing from the immutable
`cli-v0.1.2` tag, run:

```bash
npm run package:published-smoke -- 0.1.2
```

This command uses an empty npm cache, a temporary non-repository directory, a
dedicated Playwright browser cache, and `npx @pinyencheng/lhic@0.1.2 demo --safe`
with OpenAI credentials removed. For every environment, record the OS release, Node
version, Playwright version, browser revision, exact commit SHA, command
output, start/end time, and any failure. A clean-room three-platform matrix and
a published-package smoke test are still required before claiming cross-platform
`npx` success.
