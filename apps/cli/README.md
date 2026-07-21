# LHIC

LHIC is a local-first controller for deterministic browser and global desktop
actions. It runs browser Fast Path actions directly through Playwright and
controls macOS, Windows, and Linux desktops through native OS APIs.

## Beginner workflow

After installing the CLI, start with one command:

```bash
lhic setup
```

`setup` initializes local Skill memory, runs the browser/runtime checks, and
prints a reviewed Codex MCP configuration. Select a different supported client
when needed:

```bash
lhic setup claude-code
lhic setup vscode
lhic setup antigravity
```

The MCP configuration is emitted only when the compiled local MCP server exists
at `apps/mcp-server/dist/index.js`. If it has not been built, setup explains the
exact build step instead of printing a configuration that cannot start.

When something does not work, run:

```bash
lhic doctor
```

The report separates required browser-runtime failures from optional global
desktop support and gives a concrete repair command for Node.js, Chromium,
trace storage, runtime policy, network checks, and platform permissions.

Inspect what LHIC has learned without opening SQLite manually:

```bash
lhic skills
```

The output shows every local Skill lifecycle, success and failure counters, and
the next verified milestone. Candidate Skills show progress toward three
independent runs and the separate holdout requirement.

Run `lhic` with no arguments to choose a legacy command interactively. The CLI
also guides terminal users through required values omitted from `shared enable`,
`shared login`, `mcp config`, `run action`, benchmark readiness/evidence, and
trace inspection. Fully specified commands remain non-interactive for scripts
and CI.

The single-purpose shortcuts `lhic global`, `lhic bench simulate`, `lhic mcp`,
and `lhic trace` select their only subcommand automatically.

## Install the CLI or native Control Center

Install the complete CLI, its npm dependencies, and the matching local
Playwright Chromium runtime persistently:

```bash
npx @pinyencheng/lhic install cli
```

On macOS and Linux the command registers `~/.local/bin/lhic` in the active
zsh/bash interactive shell configuration; open a new terminal before using
`lhic` directly. `npx` always uses a temporary package directory, so use the
public compatibility entry when a persistent global install is not wanted:

```bash
npx lhic doctor
```

The native desktop package remains a development build until its platform
release workflow publishes matching installers and a SHA-256 manifest. After
that gate is green, download and install the SHA-256-verified desktop
application from the latest GitHub Release:

```bash
npx @pinyencheng/lhic install desktop
```

macOS installs the app to `~/Applications`, Linux installs a user-local
AppImage and launcher, and Windows launches the release NSIS installer.

## Interactive learning demo

Start the local demonstration portal with one command:

```bash
npx lhic demo
```

The portal lets you enter the browser task to demonstrate, its public HTTPS
website, and the provider credentials/model to use. It opens a visible browser
for the task, stores the provider key only in the operating-system Keychain,
and keeps the portal on loopback. Use the scoped package if you prefer it:

```bash
npx @pinyencheng/lhic demo
```

Use `lhic demo --terminal` for the original terminal-guided learning flow.

To use a provider-compatible custom structured-output endpoint, pass it on the
command line or enter it when prompted. HTTPS is required, except for an HTTP
loopback endpoint such as a local model server. Custom endpoint keys use a
separate Keychain entry from the provider default.

```bash
npx lhic demo --terminal --endpoint https://models.example.com/v1/responses
```

The CLI stores the selected provider key in the operating-system Keychain,
opens a fresh Chromium profile on a public HTTPS website, and first runs a Slow
Path task. Slow Path sends a redacted observation to the selected model for
every step, then verifies each local action. After a verified task is learned
locally, enter a similar prompt: Fast Path performs one planning-model request
and executes the returned complete browser plan locally without model calls
during execution. Click, key-press, and download actions pause for human
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

The Demo tab drives the same API-key, provider, bounded Slow Path, and
candidate-learning flow in a separate visible Chromium window. A candidate
requires three independent verified runs plus an offline holdout before it can
enter Fast Path. The MCP tab generates a client-specific local stdio
configuration for Codex, Claude Code, VS Code, or Antigravity; review and paste
it into the selected client yourself. It never rewrites MCP settings. Use
`lhic gui mcp --no-open` to print a local GUI URL without launching the default
browser.

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
