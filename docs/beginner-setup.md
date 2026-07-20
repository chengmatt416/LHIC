# Beginner setup and recovery

LHIC now provides three commands for users who do not need to work directly with
its internal SQLite, Playwright, or MCP implementation details.

## First-time setup

From a built repository checkout, run:

```bash
lhic setup codex .
```

Replace `codex` with `claude-code`, `vscode`, or `antigravity` when appropriate.
The command initializes local Skill memory, checks the browser runtime, verifies
that the compiled MCP server exists, and prints a configuration for review. It
does not silently modify an MCP client configuration.

## Diagnose a problem

```bash
lhic doctor
```

Required browser-runtime failures are reported separately from optional global
desktop-control warnings. Each failed check includes a concrete repair action.
Desktop control can remain unavailable while browser automation is usable.

## Inspect learning progress

```bash
lhic skills
```

The output explains each Skill lifecycle stage and the next verified-success
milestone. Unpromoted candidates show their independent-run and offline-holdout
progress instead of appearing to be silently ignored.

## Safety boundaries

These commands do not weaken LHIC's existing boundaries. MCP configuration is
printed for review, global desktop actions still require matching human
approval, verifier evidence is still mandatory, and the deterministic Fast Path
remains model-free.
