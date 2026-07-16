# Built during OpenAI Build Week

This file distinguishes pre-existing LHIC work from Build Week delivery work.
It intentionally maps only verifiable Git history; public video, Devpost, and
official Codex `/feedback` evidence are tracked separately at submission time.

| Date       | Feature                                                                                        | Commit    | Evidence                                             |
| ---------- | ---------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------- |
| 2026-07-16 | Typed intent compilation and execution tracing                                                 | `00e1f27` | Controller, executor, and trace tests                |
| 2026-07-16 | Shared-skills registry and CLI/MCP integration                                                 | `b245341` | Shared-skill and MCP tests                           |
| 2026-07-16 | Guided interactive CLI setup                                                                   | `6e957e3` | `apps/cli/src/interactive.test.ts`                   |
| 2026-07-16 | GPT-5.6 structured Slow Path, safe demo, raw benchmark artifact support, and Judge-facing docs | `bafa253` | `npm run demo`, provider tests, and benchmark output |
| 2026-07-16 | Package tarball dependency correction for clean-install CLI demo                               | `6d7e213` | Clean temporary install runs `lhic demo`             |

## Carry-over code

The repository includes earlier local-first execution, policy, verifier,
memory, browser, and security foundations. Build Week evidence must not imply
that those earlier components were created from scratch during the event.

## Release evidence to add before submission

1. Create an immutable release tag after the final verification pass.
2. Record the official Codex `/feedback` Session ID for the core development
   work; do not use a guessed or documentation-only session.
3. Add the public demo video URL, Devpost draft URL, and release artifact hash.
4. Preserve terminal output for the clean-room demo and benchmark runs.
