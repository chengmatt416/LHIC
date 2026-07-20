# Devpost submission draft

Use this text as a starting point for the final OpenAI Build Week submission.
It separates verified repository facts from owner-only information that must be
filled only after it exists.

## Track

Developer Tools

## Tagline

LHIC turns GPT-5.6 plans into deterministic, policy-controlled, and verifiable
browser actions.

## Inspiration

Computer-use agents can be impressive in demos but difficult to deploy safely.
Credentials can reach model context or traces, UI changes can break brittle
selectors, and high-risk actions often lack an auditable approval boundary.

## What it does

LHIC is a local-first runtime for browser and desktop automation. GPT-5.6
handles ambiguous Slow Path planning through a strict structured-output
contract. LHIC redacts sensitive fields before that request, validates the
returned plan, uses deterministic Playwright-based Fast Paths for supported
actions, requires human approval for high-risk operations, and collects
verifier evidence after execution.

The included safe demo needs neither an account nor an API key. It runs a local
browser fixture, verifies a completed action, and demonstrates that a
destructive intent is blocked at the `ask_user` approval boundary.

## How we built it

The maintainer set the product direction, architecture, threat model, and
acceptance criteria, then reviewed and accepted the engineering decisions.
Codex assisted throughout implementation, test creation, debugging,
refactoring, benchmark tooling, and documentation. The runtime is TypeScript,
uses Playwright directly for Fast Path browser actions, and keeps MCP and model
access outside the Fast Path.

## How GPT-5.6 is used

When `OPENAI_SLOW_PATH_ENABLED=true`, the OpenAI Responses API provider calls
`gpt-5.6` with strict JSON Schema structured output and `store: false`. The
provider has a 30-second fail-closed timeout, redacts sensitive request fields,
handles refusals and malformed output, and validates proposed actions again
before LHIC can use them. GPT-5.6 plans; it does not bypass policy, approval,
or verifier requirements.

## Accomplishments we are proud of

- A working credential-free local Judge Demo with verifier evidence and a
  destructive-action approval gate.
- A 60-fixture internal regression benchmark that emits raw results without
  overwriting an existing artifact.
- A package smoke path that packs the CLI, installs it in a fresh directory,
  installs Chromium, and runs the demo. GitHub Actions is configured to run
  that smoke test on Ubuntu, macOS, and Windows.
- A documented separation between controlled local ablations and external
  benchmark or SOTA claims.

## Challenges we ran into

The primary engineering challenge was enforcing a useful separation between
probabilistic reasoning and deterministic execution. A model plan must remain
untrusted until it has passed schema validation, policy checks, approval gates,
and post-action verification. Packaging the CLI uncovered a real symlink entry
point and dependency-boundary issue; the clean-install smoke test now guards
against that regression.

## What we learned

Reliable computer-use tooling needs proof of execution as much as it needs a
good plan. Local fixtures and scoped benchmarks are valuable engineering
signals, but they should not be generalized into public-web or SOTA claims.

## What's next

- Run a real GPT-5.6 demo with a redacted recording and evidence artifact.
- Collect immutable package, release, and three-platform CI evidence.
- Run the complete pinned external benchmark protocol and arrange independent
  reproduction before making comparative claims.

## Owner-only fields required before submission

Do not submit until each item below is replaced with a real, publicly
verifiable value:

| Item                                                                       | Value to provide |
| -------------------------------------------------------------------------- | ---------------- |
| Public YouTube video under three minutes, with voiceover                   | `REQUIRED`       |
| Public Devpost project URL                                                 | `REQUIRED`       |
| Published package version and `npx @pinyencheng/lhic demo --safe` evidence | `REQUIRED`       |
| Immutable release tag, artifact hash, and release URL                      | `REQUIRED`       |
| Official core Codex `/feedback` Session ID                                 | `REQUIRED`       |
| Actual GitHub Actions URLs for all three package-smoke runners             | `REQUIRED`       |
| Eligibility, IP, third-party assets, and current Rules/FAQ confirmation    | `REQUIRED`       |

See [judge guide](judge-guide.md), [demo script](demo-script.md),
[GPT-5.6 integration](gpt-5.6-integration.md), and
[reproducibility](reproducibility.md) for the supporting evidence.
