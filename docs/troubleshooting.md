# Troubleshooting

## Unsupported Node.js

LHIC requires Node.js 24 because local memory uses `node:sqlite`. Check with
`node --version`, install Node 24, then rerun `npm ci`.

## Chromium is missing

Install the pinned Playwright browser from the repository root:

```bash
npm run pw:install
```

On Linux, install the system dependencies suggested by Playwright before
retrying. Do not bypass the error by switching a production workflow to raw
mouse coordinates.

## GPT-5.6 Slow Path is blocked

This is expected unless both variables are configured in the current shell:

```bash
OPENAI_SLOW_PATH_ENABLED=true
OPENAI_API_KEY=...
```

If the provider reports a timeout, invalid structured output, or a refusal, it
fails closed. Inspect the redacted result, gather missing task context, or ask
the user rather than retrying an action blindly.

## Desktop capability is unavailable

Run `lhic global doctor`. Grant only the OS accessibility or automation
permission required by the approved workflow, and see
[global control](global-control.md) for platform-specific requirements.

## Cleanup

`npm run demo -- --safe`, browser tests, and benchmarks close the browser and remove their
temporary directories. If an interrupted local process remains, stop it before
starting a new session; never reuse an unknown browser profile or real account
session for the demo.
