# Contributing to ComputerIntent

First off, thank you for considering contributing to ComputerIntent! We welcome contributions that align with the project's mission: building a local-first, deterministic, verifiable human-intent controller.

## Code of Conduct

By participating in this project, you agree to maintain a respectful, inclusive, and constructive community.

## How to Contribute

### Reporting Bugs

1. Check the [existing issues](https://github.com/chengmatt416/ComputerIntent/issues) to avoid duplicates.
2. Open a [new bug report](https://github.com/chengmatt416/ComputerIntent/issues/new?template=bug_report.md) with:
   - A clear, descriptive title
   - Steps to reproduce
   - Expected vs actual behavior
   - Environment details (Node version, OS, browser)

### Suggesting Features

1. Open a [feature request](https://github.com/chengmatt416/ComputerIntent/issues/new?template=feature_request.md).
2. Explain the use case and how it aligns with the project's [core rules](AGENTS.md#core-rules).
3. Indicate whether it's a Fast Path or Slow Path change.

### Pull Requests

1. **Fork the repository** and create a branch from `main`.
2. **Follow the implementation style** in [AGENTS.md](AGENTS.md#implementation-style):
   - Use TypeScript for the core runtime.
   - Keep modules small and testable.
   - Prefer pure functions for schema, policy, scoring, and compiler logic.
3. **Run validation** before submitting:

   ```bash
   npm run typecheck
   npm test
   npm run lint
   npm run format:check
   ```

4. **Include tests** for new features or bug fixes.
5. **Update documentation** — if you change the CLI, API, or architecture, update the relevant docs.
6. **Follow the handoff format** from [AGENTS.md](AGENTS.md#handoff-format):
   - List changed files
   - Describe what was implemented
   - Report validation commands and results
   - Note known gaps or risks
   - Recommend next task(s)

### Commit Style

- Use clear, descriptive commit messages.
- Prefix commits with the package or area (e.g., `controller:`, `skills:`, `docs:`).
- Keep commits small and focused on a single concern.

## Development Setup

```bash
git clone https://github.com/chengmatt416/ComputerIntent.git
cd ComputerIntent
npm ci
npm run pw:install
npm run build
npm test
```

## Project Structure

```
packages/
  schema/      — TypeScript types (no runtime dependencies)
  trace/       — Redacted JSONL logging, hashing
  security/    — Risk policy, redaction, runtime config
  browser/     — Playwright SDK wrappers
  verifier/    — Evidence collection (DOM, URL, network, file)
  skills/      — Deterministic action skills
  controller/  — Intent parsing, classification, routing
  memory/      — SQLite-backed persistence
apps/
  cli/         — CLI entry point
```

## Fast Path Rules (Non-negotiable)

- ❌ No LLM calls
- ❌ No MCP usage
- ❌ No OCR, VLM, or raw coordinate clicks
- ✅ Use Playwright SDK / CDP directly
- ✅ Use API / DOM / Accessibility / OS automation
- ✅ Every action needs verifier evidence
- ✅ Every task needs trace events
- ✅ Never log credentials or unredacted PII

## Getting Help

- Open a [discussion](https://github.com/chengmatt416/ComputerIntent/discussions) for questions.
- Tag maintainers with `@chengmatt416` in issues if urgent.
