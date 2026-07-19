# Local Human Intent Controller (LHIC)

LHIC is a secure, high-performance, local-first browser and desktop automation
runtime designed to translate human intent into deterministic, verifiable
computer actions.

**The secure execution runtime for computer-use agents.** GPT-5.6 can handle
ambiguous Slow Path planning through a strict, redacted schema; LHIC validates,
executes, verifies, and audits actions locally. The Fast Path never calls a
model or MCP server.

## 🚀 Key Features

- **Fast Path Execution Engine**: Executes common browser tasks (login, forms, search, navigation) locally using Playwright and high-level skills, bypassing LLMs entirely. Each Fast Path action has **zero LLM calls** and therefore incurs no LLM-token cost; latency and success claims are reported only from the included controlled benchmarks.
- **Global Desktop Control**: Executes approved native actions across macOS, Windows, and Linux: focus or launch apps, type, press hotkeys, and click. Every desktop action requires a matching human approval and a post-action window or process verifier.
- **Semantic Locator Resilience**: In the included 100-task, five-layout local ablation, verified semantic targeting succeeds on all fixtures while the intentionally limited static-selector baseline succeeds on 20%; this is an 80-percentage-point controlled result, not a general web benchmark.
- **Security & KMS Controls**:
  - **KmsKeyManager**: Verifies Ed25519 approval keys from local configuration or explicitly configured GCP KMS / HashiCorp Vault. Missing, invalid, or unsupported resolvers fail closed; AWS requires a SigV4-authenticated resolver.
  - **AES-256-GCM Encryption**: Secure software-based database-level static encryption for sensitive user cookies and sessions.
  - **PII & Credential Guard**: Automatically redacts credentials, passwords, and personally identifiable information from all system traces.
- **Enterprise Concurrency & Durability**:
  - **BrowserPool**: Thread-safe Chromium context pooling with pre-warming and state purification.
  - **Account-level Locking**: Distributed SQL-based queue preventing overlapping executions on identical accounts.
  - **Durable Workflows**: Resilient workflow execution with step recovery and state-saving.
- **VNC Screencast Streaming**: CDP-based real-time JPEG screen frame broadcast at configurable frame rates (e.g., 10fps) for remote intervention.
- **APM Observability**: OpenTelemetry (OTLP) exporting mapping tracking spans to central log systems.

## 📁 Package Monorepo Structure

- `packages/schema`: Core TypeScript schemas and validation types.
- `packages/browser`: Playwright CDP wrappers, Screencast, and BrowserPool.
- `packages/verifier`: Dynamic DOM, URL, and file download verification.
- `packages/trace`: Redacted JSONL event logs and OTel APM export.
- `packages/memory`: SQLite workflow state and resilient selector memory.
- `packages/security`: KMS key managers, PII redaction, and database encryption.
- `packages/skills`: Fault-tolerant browser skills and the native global-desktop executor.
- `packages/controller`: Decision routing, confidence scorer, and Slow Path interface.
- `packages/shared-skills`: Reviewed-skill cache, registry sync, and publication outbox.
- `packages/game-training`: Local dataset, policy-artifact, and game-control contracts.
- `packages/game-training-2d` / `packages/game-training-3d`: Core-specific control bounds.
- `apps/cli`: LHIC CLI command entrypoint (`lhic`).
- `apps/lhic`: Compatibility entrypoint for `npx lhic`.
- `apps/desktop`: Electron Control Center.
- `apps/mcp-server`: Standard Model Context Protocol stdio entrypoint and HTTP API Control Plane.

## 🛠️ CLI Commands & Usage

### Quick start

Install dependencies and the local Chromium runtime:

```bash
npm ci
npm run pw:install
npm run build
```

Run the credential-free local Judge Demo. It executes a real browser fixture,
verifies the result, and shows that a destructive intent is approval-gated:

```bash
npm run demo
```

The npm registry contains `@pinyencheng/lhic@0.1.1`, but that release predates
the current Judge Demo and its `npx @pinyencheng/lhic@0.1.1 demo` command does
not exist. Do not use it as release evidence. Until the `0.1.2` release is
published and passes the registry smoke test, use this checkout's commands
above or run `npm run package:smoke` to verify the release tarball. The package
requires Node.js 24 and a local Playwright Chromium installation; it declares
support for macOS, Windows, and Linux. Native desktop control has additional
platform permissions described in the [global control guide](docs/global-control.md).

To include a real GPT-5.6 Slow Path planning request in the demo, set an API
key only in the process environment. The provider sends a redacted request,
uses `store: false`, and remains disabled unless explicitly enabled:

```bash
OPENAI_SLOW_PATH_ENABLED=true OPENAI_API_KEY=... npm run demo
```

See the [GPT-5.6 integration guide](docs/gpt-5.6-integration.md) for the
schema, safety boundary, and failure behavior. Never put a key in an action
file, trace, repository, screenshot, or demo recording.

See the [0.1.2 release notes](docs/release-notes-0.1.2.md) for the exact
release-candidate evidence and the remaining publication gates.
The CLI and Desktop release independently; see the machine-checked
[release status](docs/release-status.md) before using a version as release
evidence.

### npm CLI and desktop installation (after the current release is verified)

`npx` fetches a package into a temporary execution directory; it does not add a
command to your shell PATH. To install the complete scoped CLI, its npm
dependencies, and the matching local Playwright Chromium runtime persistently,
run this once:

```bash
npx @pinyencheng/lhic install cli
```

On macOS and Linux this creates `~/.local/bin/lhic` and adds that directory to
your zsh/bash interactive shell configuration. Restart the terminal before using `lhic` directly. On
Windows, npm's global bin directory is used; ensure the normal npm global bin
path is available after restarting the terminal.

The public `lhic` compatibility package is not published yet. After the scoped
CLI and compatibility package both pass their registry smoke tests, it will run
the same full CLI without a global install:

```bash
npx lhic preflight
```

Install the native Control Center for the current operating system and
architecture with a SHA-256-verified GitHub Release asset. macOS installs to
`~/Applications`, Linux installs a user-local AppImage and launcher, and
Windows runs the release NSIS installer:

```bash
npx @pinyencheng/lhic install desktop
```

The desktop installer rejects assets without a matching entry in the release
checksum manifest and does not require an administrator password on macOS or
Linux.

### Published CLI commands

After the current npm release passes `npm run package:published-smoke -- 0.1.2`,
initialize the local-first runtime and its
persistent SQLite skill database. This preloads the shipped `download_file`,
`fill_form`, `login`, `search`, and `test_web_flow` skills without overwriting
learned skills:

```bash
npx @pinyencheng/lhic start
npx @pinyencheng/lhic preflight
npx @pinyencheng/lhic global doctor
```

The database is created at `.lhic/skills.sqlite` in the current directory. Use
`npx @pinyencheng/lhic start <memory-database>` to choose a different
location. See [the quick-start guide](docs/quickstart.md) for the MCP setup and
the first automation workflow.

For Codex, print a reviewed MCP entry using the built-in command. It never
modifies client configuration automatically:

```bash
npx @pinyencheng/lhic mcp config codex
```

For a local graphical companion, run the visible learning Demo or generate a
reviewable MCP client configuration in a browser tab:

```bash
npx @pinyencheng/lhic gui
npx @pinyencheng/lhic gui mcp
```

The companion binds only to loopback, requires a per-launch capability token,
and does not modify MCP client configuration automatically.

For the full native Control Center (Skills, task admission, MCP review, game
training, security, and Judge Center), build and launch the Electron app:

```bash
npm run desktop:build
npm run desktop:start
```

The Security panel stores only the selected local Slow Path budget profile in
`.lhic/security-settings.json` (mode `0600`); provider credentials remain in
the operating-system Keychain. Selecting `fast_only` prevents provider calls
for new tasks. Interactive approvals, verifier evidence, redaction, and the
model-free Fast Path are mandatory controls and cannot be disabled from the
desktop app.

See the [Desktop Control Center guide](docs/desktop-control-center.md) for the
Appwrite GitHub-OAuth judge setup, local Keychain boundary, and packaging.

Run preflight environment verification:

```bash
npx @pinyencheng/lhic preflight
```

Run action with human approval:

```bash
npx @pinyencheng/lhic run action <action-file> [approval-file]
```

Run a complete, locally verified browser recipe with declared variables:

```bash
npx @pinyencheng/lhic run plan <plan-file>
```

A `browser-plan-v1` recipe contains a goal and a verifier for every browser
step. In an interactive development or test terminal, LHIC prompts locally for
any declared variables and asks for confirmation before each click, key press,
download, or elevated-risk step. It executes entirely through the model-free
Fast Path and returns execution plus verifier evidence for every completed
step. Scripts can instead provide `[approvals-file] --var name=value`; production
requires matching externally signed approvals keyed by plan step ID. See the
[quick-start guide](docs/quickstart.md) for the plan contract and invocation
details.

For desktop actions, run `npx @pinyencheng/lhic global doctor` first and use an action file
with `scope: "os"`, a native method preference, and a required `verifier`.
Global actions are always approval-gated, including low-risk labels. See the
[global control guide](docs/global-control.md) for the JSON contract, platform
requirements, and examples.

Slow Path integrations can use a budgeted `MultiPathTaskController` with a
`SlowPathLearningCoordinator`. When every proposed action has a successful
execution result and non-empty verifier evidence, LHIC stores only a redacted
candidate in SQLite. A candidate becomes Fast Path eligible only after three
independent task IDs and a deterministic offline holdout pass. Successful
direct DOM actions also add local selector-memory candidates; the MCP server
exposes redacted `lhic_runtime_status`, `lhic_skills_list`, and
`lhic_selector_memory_list` views for inspection.

A completed `lhic_browser_execute_plan` MCP batch is also eligible for local
Skill training when every step has execution and verifier evidence. LHIC stores
a redacted, parameterized candidate only after the batch completes; individual
MCP actions, approval pauses, and failed plans are excluded. A planner can
specify or declare parameters before the batch starts, but the executor never
calls a model while it runs.

### Optional public shared skills

Deploy the reviewed Appwrite Function template in
[`services/appwrite-shared-skills`](services/appwrite-shared-skills), then
enable the registry for a workspace. In a terminal, the short command guides
you through the Appwrite endpoint, project, function URL, and Magic URL email:

```bash
npx @pinyencheng/lhic shared enable
```

The explicit form remains available for scripts and CI:

```bash
npx @pinyencheng/lhic shared enable \
  --endpoint https://<region>.cloud.appwrite.io/v1 \
  --project <project-id> \
  --function-url https://<function-domain> \
  --email you@example.com
```

The CLI stores only non-secret registry configuration in `.lhic`; the Appwrite
session stays in the OS credential store. The local cache is refreshed on the
next runtime start after 24 hours, and failed syncs retain the last verified
cache. Use `lhic shared status`, `lhic shared sync --force`, and
`lhic shared list` to inspect it. Only approved low-risk browser skills with a
unique local operation/UI-fingerprint match can enter Fast Path; no Fast Path
request accesses the network.

Running `lhic` with no command opens the same terminal guide. It also asks for
missing required values for `mcp config`, `run action`, benchmark readiness and
evidence validation, and trace inspection. Supplying every argument keeps the
commands non-interactive for scripts and CI.

Single-purpose command groups are shortened too: `lhic global` runs the
desktop capability doctor, `lhic bench simulate` runs the resilience
simulation, `lhic mcp` starts MCP configuration, and `lhic trace` starts trace
inspection.

Run internal regression benchmarks:

```bash
npx @pinyencheng/lhic bench internal
```

Run selector resilience simulation:

```bash
npx @pinyencheng/lhic bench simulate resilience
```

## Build Week evidence

Judge-facing material is collected in the following documents:

- [Judge guide](docs/judge-guide.md): 60-second and extended verification paths.
- [GPT-5.6 integration](docs/gpt-5.6-integration.md): runtime role and trust boundary.
- [Build Week changelog](docs/build-week-changelog.md): dated commit evidence.
- [Benchmark methodology](docs/benchmark-methodology.md): controlled-fixture scope and limitations.
- [Reproducibility](docs/reproducibility.md), [troubleshooting](docs/troubleshooting.md), and [known limitations](docs/known-limitations.md).
- [Codex collaboration](docs/codex-usage.md) and the [recording script](docs/demo-script.md).
- [Devpost submission draft](docs/devpost-submission.md), with owner-only evidence fields clearly separated from verified repository facts.

The remaining submission-only evidence—public video URL, Devpost entry,
official `/feedback` session ID, clean-room platform matrix, and release
publication—must be supplied and verified at submission time. LHIC does not
claim these are complete before that evidence exists.

## 📄 License

Dual-licensed under the MIT License and the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
