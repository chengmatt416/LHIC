# AGENTS.md — Local Human Intent Controller

## Mission

Build a local-first Human Intent Controller that converts user intent into deterministic, verifiable computer actions.

## Core Rules

- Fast Path must not call LLMs.
- Fast Path must not use MCP.
- Use Playwright SDK / CDP directly for browser Fast Path.
- Use MCP only for Slow Path, debugging, or external agent integration.
- Do not add Gemini Live.
- Claude / Claude Code / Anthropic APIs are optional Slow Path only.
- Prefer API / DOM / Accessibility / OS automation over OCR, VLM, and raw coordinates.
- Every action needs verifier evidence.
- Every task needs trace events.
- Never log credentials or unredacted PII.
- Ask before introducing new runtime dependencies.

## Implementation Style

- Use TypeScript for the core runtime.
- Keep modules small and testable.
- Do not implement later phases unless explicitly requested.
- Work in small commits or task-sized diffs.
- Prefer pure functions for schema, policy, scoring, and compiler logic.

## Validation Commands

Run these when relevant:

```bash
npm run typecheck
npm test
npm run lint
```

If a command fails because tooling does not exist yet, create the minimal tooling in the current task or report that it is not available.

## Handoff Format

After each task, report:

1. Changed files
2. What was implemented
3. Validation commands and results
4. Known gaps / risks
5. Recommended next task
