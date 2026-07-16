# MCP harness integrations

LHIC exposes a standards-based local stdio MCP server. Any MCP-capable agent
can use browser actions plus read-only runtime and learning inspection; client
configuration is the only integration-specific part.

```text
AI or harness → LHIC stdio MCP process → serialized browser session → Playwright
```

Each server process owns one fresh Chromium browser session and serializes tool
calls in arrival order. Start one process per independent workflow. MCP stdout
is protocol-only JSON, so start the compiled entrypoint directly with `node`;
do not use `npm run` as the MCP command because its lifecycle output corrupts a
stdio protocol stream.

To avoid hand-copying client-specific paths, the CLI can print a reviewed
configuration snippet without modifying a client file:

```bash
lhic mcp config codex /absolute/path/to/ComputerIntent
lhic mcp config claude-code /absolute/path/to/ComputerIntent
lhic mcp config vscode /absolute/path/to/ComputerIntent
lhic mcp config antigravity /absolute/path/to/ComputerIntent
```

Use the generated absolute path after a build; review the output before adding
it to the respective client configuration. The Antigravity and VS Code outputs
also set `cwd` to the supplied workspace root so relative LHIC runtime paths
are stable even when the client itself is launched elsewhere.

## Prerequisites

```bash
npm ci
npm run pw:install
npm run build
```

Use Node 24, run the client on the same machine that should own the browser,
and replace `/absolute/path/to/ComputerIntent` in the examples below. The
browser is visible by default. Set `LHIC_MCP_HEADLESS=true` only for unattended
workloads such as a CI harness.

Set `LHIC_MEMORY_DATABASE=/absolute/path/skills.sqlite` to choose where the
server keeps local skill and selector memory. If unset, the server creates
`.lhic/skills.sqlite` in its working directory and preloads built-in skills.

For a production session, configure the existing runtime policy in the MCP
server environment:

```text
LHIC_ENV=production
LHIC_ALLOWED_ORIGINS=https://app.example.com,https://admin.example.com
LHIC_APPROVAL_PUBLIC_KEY=<Ed25519 public key PEM>
LHIC_TRACE_DIRECTORY=/secure/trace/directory
```

Production blocks private-network navigation, requires the HTTPS allowlist,
and requires a matching signed `ActionApproval` for high-risk actions.

## Antigravity CLI

This repository includes the workspace plugin at
`.agents/plugins/lhic-computer-use`. Start `agy` from the repository root after
building, then inspect `/mcp`. See [Antigravity computer use](antigravity-computer-use.md)
for the tool contract.

## Codex CLI, IDE extension, and ChatGPT desktop app

Codex's local clients share MCP configuration. For a repository-scoped
`.codex/config.toml`, use a reviewed absolute path and prompt for all tool
calls:

```toml
[mcp_servers.lhic_computer_use]
command = "node"
args = ["/absolute/path/to/ComputerIntent/apps/mcp-server/dist/index.js"]
cwd = "/absolute/path/to/ComputerIntent"
startup_timeout_sec = 20
tool_timeout_sec = 45
default_tools_approval_mode = "prompt"
```

Use `/mcp` in Codex after restarting the client to check the connection. Codex
supports local stdio MCP servers and treats server instructions as cross-tool
guidance; LHIC uses this to require observation and approval-aware semantic
actions. See the [official Codex MCP guide](https://developers.openai.com/codex/mcp/).

## Claude Code

From the repository root, add a project-scoped server:

```bash
claude mcp add --scope project --transport stdio lhic-computer-use -- \
  node apps/mcp-server/dist/index.js
```

Alternatively, add this to a reviewed project `.mcp.json`; the environment
default keeps the path portable for a project checkout:

```json
{
  "mcpServers": {
    "lhic-computer-use": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/apps/mcp-server/dist/index.js"]
    }
  }
}
```

Confirm the server in Claude Code with `/mcp`. Claude Code asks for approval of
project-scoped MCP servers; retain that review step rather than bypassing it.

## VS Code and GitHub Copilot Chat

Create `.vscode/mcp.json` with the workspace-scoped configuration:

```json
{
  "servers": {
    "lhicComputerUse": {
      "type": "stdio",
      "command": "node",
      "args": ["apps/mcp-server/dist/index.js"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

Use **MCP: List Servers** to start and inspect it. VS Code presents a trust
decision for local servers; do not enable it in an untrusted checkout.

## Tool-use contract for every harness

1. Optionally call `lhic_runtime_status` to inspect the local runtime and
   `lhic_skills_list` and `lhic_selector_memory_list` to inspect redacted
   learning metadata.
2. Call `lhic_browser_start`, then `lhic_browser_observe` before selecting a
   target.
3. Send exactly one supported action (`navigate`, `click`, `fill`, `select`,
   `press`, or `wait`) to `lhic_browser_act`.
4. Check `result.success`, evidence, and returned state after every action.
5. Never fabricate `ActionApproval`; acquire human confirmation for high- or
   unknown-risk work.
6. Call `lhic_browser_close` when the workflow ends.

`lhic_browser_observe` is marked read-only and idempotent in MCP metadata;
state-changing tools are conservatively marked for approval-aware clients.
Input values are omitted from observations and all tool output is redacted. Each
result is available both as universally compatible JSON text and as MCP
`structuredContent` for harnesses that support structured tool results.
`lhic_runtime_status`, `lhic_skills_list`, and `lhic_selector_memory_list` are
read-only and idempotent. Skill listings include lifecycle counters only, and
selector-memory listings omit saved selectors. Neither returns stored action
definitions or input values.

Configuration formats above are based on the current [Codex MCP
documentation](https://developers.openai.com/codex/mcp/), [Claude Code MCP
documentation](https://code.claude.com/docs/en/mcp), and [VS Code MCP
configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
