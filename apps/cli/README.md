# LHIC

LHIC is a local-first controller for deterministic browser and global desktop
actions. It runs browser Fast Path actions directly through Playwright and
controls macOS, Windows, and Linux desktops through native OS APIs.

Run `lhic` with no arguments to choose a command interactively. The CLI also
guides terminal users through required values omitted from `shared enable`,
`shared login`, `mcp config`, `run action`, benchmark readiness/evidence, and
trace inspection. Fully specified commands remain non-interactive for scripts
and CI.

The single-purpose shortcuts `lhic global`, `lhic bench simulate`, `lhic mcp`,
and `lhic trace` select their only subcommand automatically.

## Interactive learning demo

Run the complete visible-browser demo with one provider API key and model:

```bash
npx @pinyencheng/lhic demo
```

Running `lhic` without arguments exposes the same Demo choices in the terminal
menu: Learning or Safe mode, Safe browser visibility, and an optional Learning
endpoint. The menu emits the equivalent command-line options, so both forms
remain interchangeable.

To use a provider-compatible custom structured-output endpoint, pass it on the
command line or enter it when prompted. HTTPS is required, except for an HTTP
loopback endpoint such as a local model server. Custom endpoint keys use a
separate Keychain entry from the provider default.

```bash
npx @pinyencheng/lhic demo --endpoint https://models.example.com/v1/responses
```

The CLI stores the selected provider key in the operating-system Keychain,
opens a fresh Chromium profile on a public HTTPS website, and first runs a
Slow Path task. Slow Path sends a redacted observation to the selected model
for every step, then verifies each local action. After a verified task is
learned locally, enter a similar prompt: Fast Path performs one planning-model
request and executes the returned complete browser plan locally without model
calls during execution. Click, key-press, and download actions pause for human
approval. The first local similarity lookup downloads the embedding model once
and caches it locally.

`lhic demo --safe` retains the credential-free local fixture used by CI and
package smoke tests.

Use `--viewable` (or `--view`) with the safe fixture to see its browser actions
and keep the window open until Enter is pressed. The interactive learning demo
is always visible.

```bash
npx @pinyencheng/lhic demo --safe --viewable
```

## GUI Companion

Launch a local-only web GUI for the visible learning demo and the MCP Link
Companion:

```bash
npx @pinyencheng/lhic gui
```

The Demo tab drives the same API-key, provider, Slow Path, learning, and Fast
Path flow in a separate visible Chromium window. The MCP tab generates a
client-specific local stdio configuration for Codex, Claude Code, VS Code, or
Antigravity; review and paste it into the selected client yourself. It never
rewrites MCP settings. Use `lhic gui mcp --no-open` to print a local GUI URL
without launching the default browser.

```bash
npx @pinyencheng/lhic global doctor
```

Global desktop actions are JSON files executed with:

```bash
npx @pinyencheng/lhic run action <action.json> <approval.json>
```

Every global action must include `scope: "os"`, a native method preference, a
post-action verifier, and a matching human `ActionApproval`. Typed values are
not stored in traces. Run `lhic global doctor` before use: macOS needs terminal
Accessibility permission, Windows needs PowerShell/Win32 access, and Linux is
supported on X11 with `xdotool` (Wayland is intentionally rejected).

See the project repository for full action examples, security configuration,
and browser automation documentation.
