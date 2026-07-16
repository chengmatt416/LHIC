# Local Human Intent Controller (LHIC)

LHIC is a secure, high-performance, local-first browser and desktop automation
runtime designed to translate human intent into deterministic, verifiable
computer actions.

## 🚀 Key Features

- **Fast Path Execution Engine**: Executes common browser tasks (login, forms, search, navigation) locally using Playwright and high-level skills, bypassing LLMs entirely. Each Fast Path action has **zero LLM calls** and therefore incurs no LLM-token cost; latency and success claims are reported only from the included controlled benchmarks.
- **Global Desktop Control**: Executes approved native actions across macOS, Windows, and Linux: focus or launch apps, type, press hotkeys, and click. Every desktop action requires a matching human approval and a post-action window or process verifier.
- **Self-Healing Semantic Locators**: Immune to typical website updates. Outperforms traditional static CSS/XPath selectors by **+80% success rate** under layout modifications.
- **State-of-the-Art Security & KMS**:
  - **KmsKeyManager**: Integrates AWS KMS, GCP KMS, and HashiCorp Vault key verification for high-risk actions.
  - **AES-256-GCM Encryption**: Secure software-based database-level static encryption for sensitive user cookies and sessions.
  - **PII & Credential Guard**: Automatically redacts credentials, passwords, and personally identifiable information from all system traces.
- **Enterprise Concurrency & Durability**:
  - **BrowserPool**: Thread-safe Chromium context pooling with pre-warming and state purification.
  - **Account-level Locking**: Distributed SQL-based queue preventing overlapping executions on identical accounts.
  - **Durable Workflows**: Resilient workflow execution with step recovery and state-saving.
- **VNC Screencast Streaming**: CDP-based real-time JPEG screen frame broadcast at configurable frame rates (e.g., 10fps) for remote intervention.
- **APM Observability**: OpenTelemetry (OTLP) exporting mapping tracking spans to central log systems.

## 📁 Package Monorepo Structure

- `packages/schema`: Core Zod schemas and validation types.
- `packages/browser`: Playwright CDP wrappers, Screencast, and BrowserPool.
- `packages/verifier`: Dynamic DOM, URL, and file download verification.
- `packages/trace`: Redacted JSONL event logs and OTel APM export.
- `packages/memory`: SQLite workflow state and resilient selector memory.
- `packages/security`: KMS key managers, PII redaction, and database encryption.
- `packages/skills`: Fault-tolerant browser skills and the native global-desktop executor.
- `packages/controller`: Decision routing, confidence scorer, and Slow Path interface.
- `apps/cli`: LHIC CLI command entrypoint (`lhic`).
- `apps/mcp-server`: Standard Model Context Protocol stdio entrypoint and HTTP API Control Plane.

## 🛠️ CLI Commands & Usage

### Quick start

Install dependencies and the local Chromium runtime:

```bash
npm ci
npm run pw:install
npm run build
```

Initialize the local-first runtime and its persistent SQLite skill database.
This preloads the shipped `download_file`, `fill_form`, `login`, `search`, and
`test_web_flow` skills without overwriting learned skills:

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

Run preflight environment verification:

```bash
npx @pinyencheng/lhic preflight
```

Run action with human approval:

```bash
npx @pinyencheng/lhic run action <action-file> [approval-file]
```

For desktop actions, run `npx @pinyencheng/lhic global doctor` first and use an action file
with `scope: "os"`, a native method preference, and a required `verifier`.
Global actions are always approval-gated, including low-risk labels. See the
[global control guide](docs/global-control.md) for the JSON contract, platform
requirements, and examples.

Slow Path integrations can use `FastPathRouter.executeSlowPath(...)` with a
`SlowPathLearningCoordinator`. When every proposed action has a successful
execution result and non-empty verifier evidence, LHIC compiles the plan into a
redacted skill and persists it in SQLite automatically. Successful direct DOM
actions also add local selector-memory candidates; the MCP server exposes
redacted `lhic_runtime_status`, `lhic_skills_list`, and
`lhic_selector_memory_list` views for inspection.

### Optional public shared skills

Deploy the reviewed Appwrite Function template in
[`services/appwrite-shared-skills`](services/appwrite-shared-skills), then
enable the registry for a workspace:

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

Run internal regression benchmarks:

```bash
npx @pinyencheng/lhic bench internal
```

Run selector resilience simulation:

```bash
npx @pinyencheng/lhic bench simulate resilience
```

## 📄 License

Dual-licensed under the MIT License and the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
