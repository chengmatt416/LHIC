# Local Human Intent Controller (LHIC)

LHIC is a secure, high-performance, local-first browser automation runtime designed to translate human intent into deterministic, verifiable computer actions.

## 🚀 Key Features

*   **Fast Path Execution Engine**: Executes common browser tasks (login, forms, search, navigation) locally using Playwright and high-level skills, bypassing LLMs entirely. Each Fast Path action has **zero LLM calls** and therefore incurs no LLM-token cost; latency and success claims are reported only from the included controlled benchmarks.
*   **Self-Healing Semantic Locators**: Immune to typical website updates. Outperforms traditional static CSS/XPath selectors by **+80% success rate** under layout modifications.
*   **State-of-the-Art Security & KMS**:
    *   **KmsKeyManager**: Integrates AWS KMS, GCP KMS, and HashiCorp Vault key verification for high-risk actions.
    *   **AES-256-GCM Encryption**: Secure software-based database-level static encryption for sensitive user cookies and sessions.
    *   **PII & Credential Guard**: Automatically redacts credentials, passwords, and personally identifiable information from all system traces.
*   **Enterprise Concurrency & Durability**:
    *   **BrowserPool**: Thread-safe Chromium context pooling with pre-warming and state purification.
    *   **Account-level Locking**: Distributed SQL-based queue preventing overlapping executions on identical accounts.
    *   **Durable Workflows**: Resilient workflow execution with step recovery and state-saving.
*   **VNC Screencast Streaming**: CDP-based real-time JPEG screen frame broadcast at configurable frame rates (e.g., 10fps) for remote intervention.
*   **APM Observability**: OpenTelemetry (OTLP) exporting mapping tracking spans to central log systems.

## 📁 Package Monorepo Structure

*   `packages/schema`: Core Zod schemas and validation types.
*   `packages/browser`: Playwright CDP wrappers, Screencast, and BrowserPool.
*   `packages/verifier`: Dynamic DOM, URL, and file download verification.
*   `packages/trace`: Redacted JSONL event logs and OTel APM export.
*   `packages/memory`: SQLite workflow state and resilient selector memory.
*   `packages/security`: KMS key managers, PII redaction, and database encryption.
*   `packages/skills`: Fault-tolerant pre-defined browser skills.
*   `packages/controller`: Decision routing, confidence scorer, and Slow Path interface.
*   `apps/cli`: LHIC CLI command entrypoint (`lhic`).
*   `apps/mcp-server`: Standard Model Context Protocol stdio entrypoint and HTTP API Control Plane.

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
npx lhic start
npx lhic preflight
```

The database is created at `.lhic/skills.sqlite` in the current directory. Use
`npx lhic start <memory-database>` to choose a different
location. See [the quick-start guide](docs/quickstart.md) for the MCP setup and
the first automation workflow.

For Codex, print a reviewed MCP entry using the built-in command. It never
modifies client configuration automatically:

```bash
npx lhic mcp config codex
```

Run preflight environment verification:
```bash
npx lhic preflight
```

Run action with human approval:
```bash
npx lhic run action <action-file> [approval-file]
```

Slow Path integrations can use `FastPathRouter.executeSlowPath(...)` with a
`SlowPathLearningCoordinator`. When every proposed action has a successful
execution result and non-empty verifier evidence, LHIC compiles the plan into a
redacted skill and persists it in SQLite automatically. Successful direct DOM
actions also add local selector-memory candidates; the MCP server exposes
redacted `lhic_runtime_status`, `lhic_skills_list`, and
`lhic_selector_memory_list` views for inspection.

Run internal regression benchmarks:
```bash
npx lhic bench internal
```

Run selector resilience simulation:
```bash
npx lhic bench simulate resilience
```

## 📄 License

Dual-licensed under the MIT License and the Apache License, Version 2.0. See [LICENSE](LICENSE) for details.
