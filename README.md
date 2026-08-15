# LHIC — Local Human Intent Controller

**A local-first execution, verification, and control layer for AI agents that act on real computers.**

LHIC turns high-level intent into controlled browser, desktop, and coding actions while keeping the execution authority outside the model. It combines deterministic fast paths, policy and approval gates, post-action verification, crash-safe side-effect recovery, trusted memory, and auditable action receipts.

LHIC is not a model and does not depend on one specific model family. Models and coding agents can plan or propose work; **LHIC decides what may execute, records what actually happened, and distinguishes execution from verification.**

> **Core principle:** an agent saying “done” is not proof. LHIC treats successful execution, verifier evidence, provenance, and policy compliance as separate facts.

## Why LHIC

Most computer-use agents are optimized around planning and tool calling. The difficult part begins after a tool call is proposed: Was it allowed? Did it target the right object? Did the side effect really happen? Can a crash safely resume? Can learned behavior be trusted later? Can benchmark claims be reproduced?

LHIC focuses on that execution boundary.

```text
Human intent / agent plan
          │
          ▼
┌──────────────────────────────┐
│           LHIC               │
│                              │
│  policy + risk classification│
│  approvals + authority       │
│  workspace conflict checks   │
│  execution coordination      │
│  receipts + durable ledger   │
│  verification + evidence     │
│  recovery + trusted memory   │
└──────────────┬───────────────┘
               │
      ┌────────┼─────────┐
      ▼        ▼         ▼
   Browser   Desktop    Coding
 Playwright  Native      OMP
 / CDP       control     RPC
      │        │         │
      └────────┼─────────┘
               ▼
       evidence + provenance
```

## What is implemented

### Verifiable browser execution

LHIC includes a local browser runtime built around Playwright/CDP, semantic targeting, resilient selector memory, verifier-backed plans, downloads, forms, login flows, and reusable skills.

A `browser-plan-v1` plan declares a goal and verifier for every step. Interactive development can request local confirmation before risky actions; production flows can use externally signed approvals.

The **Fast Path** executes reviewed browser behavior locally without calling a model or MCP server during execution.

### Controlled desktop automation

LHIC can execute approved native actions across macOS, Windows, and Linux, including app focus/launch, typing, hotkeys, and clicks.

Desktop execution is not treated as inherently trustworthy. Actions are paired with approval requirements and post-action verification such as process or window evidence. Platform support still depends on the operating system's accessibility and automation permissions.

### OMP-powered coding agent integration

LHIC uses OMP as its coding-agent engine while keeping the trust boundary explicit.

OMP can perform coding work and produce tool results. LHIC adds the surrounding execution contract: policy, receipts, workspace conflict awareness, evidence, recovery, and objective coding verification. Provenance is preserved in the UI and action records so an OMP tool result is never mislabeled as “LHIC verified” unless an LHIC verifier actually produced evidence.

The OMP runtime is pinned and acquired through a fail-closed integrity path before execution.

### Action receipts and provenance

Cross-surface actions can produce structured receipts containing execution identity, verification identity, evidence, authority, and result state.

This makes distinctions such as these explicit:

```text
executedBy: omp
verifiedBy: lhic

evidenceCount: 3
```

or, when no LHIC verifier ran:

```text
executedBy: omp
verifiedBy: none
```

That distinction is intentional and is part of LHIC's claim discipline.

### Policy and approval system

LHIC uses structured risk taxonomy and approval checks rather than trusting a planner to declare its own action safe.

The policy layer is designed so that a proposed action cannot lower its own effective risk classification simply by changing planner-supplied metadata. High-impact desktop and browser operations remain subject to the local authority layer.

### Crash-safe side-effect recovery

LHIC includes a durable side-effect ledger and recovery model for work that may be interrupted after a real-world effect has occurred.

The goal is to avoid the classic agent failure mode of blindly replaying an operation after a crash and creating duplicate effects. Recovery logic can distinguish planned, started, externally committed, verified, and recoverable states.

### Workspace conflict awareness

Coding work can track read sets and detect same-repository conflicts before accepting stale assumptions. Conflict state survives restart so recovery does not silently erase the fact that the workspace changed underneath an earlier plan.

### Trusted memory and learning

LHIC can learn from successful execution, but learned behavior does not immediately become trusted Fast Path behavior.

Selector memory, workflow candidates, recipes, and shared skills pass through explicit trust and staleness rules. Fast Path promotion requires verifier-backed evidence rather than a single successful run.

### MCP integration

The repository includes a standard MCP stdio server and reviewable client configuration helpers. LHIC exposes controlled runtime, skill, and memory surfaces without requiring clients to directly own the execution authority.

The HTTP API control-plane class in the repository is **experimental and not wired as a durable remote orchestration service**. It does not provide the persistence, idempotency, or lease semantics of the durable local workflow components.

### Audit, observability, and release integrity

LHIC includes redacted JSONL traces, optional OpenTelemetry export, secret scanning, release checksum verification, SBOM generation, and release hardening checks.

Sensitive values are redacted at the tracing boundary. Release tooling is designed to fail closed when expected integrity evidence is missing or mismatched.

## Quick start from source

Requirements:

- Node.js 24
- npm 11+
- a supported local environment for Playwright Chromium

```bash
npm ci
npm run pw:install
npm run build
```

Run the credential-free local demo:

```bash
npm run demo -- --safe
```

The safe demo exercises a real local browser fixture, verifier-backed execution, and approval gating without requiring a model credential.

Run the full repository verification pipeline:

```bash
npm run ci
```

Or run individual checks:

```bash
npm run typecheck
npm test
npm run lint
npm run build
npm run preflight
npm run audit:prod
npm run scan:secrets
```

## CLI

After building the repository, the CLI entrypoint is available through the workspace package.

Initialize the runtime:

```bash
npx @pinyencheng/lhic start
```

Check the local environment:

```bash
npx @pinyencheng/lhic preflight
npx @pinyencheng/lhic global doctor
```

Run an approval-gated action:

```bash
npx @pinyencheng/lhic run action <action-file> [approval-file]
```

Run a verifier-backed browser plan:

```bash
npx @pinyencheng/lhic run plan <plan-file>
```

Generate a reviewable MCP configuration:

```bash
npx @pinyencheng/lhic mcp config codex
```

Inspect traces:

```bash
npx @pinyencheng/lhic trace
```

The repository contains release and compatibility packaging work in addition to the source workflow above. Before treating a registry or desktop package as current release evidence, check the repository's machine-checked release status and release notes.

## Desktop Control Center

Build and launch the Electron Control Center:

```bash
npm run desktop:build
npm run desktop:start
```

The desktop application exposes operational surfaces for Agent Studio, skills, task admission, MCP review, security, game training, and judge/benchmark inspection.

Agent Studio renders execution provenance explicitly. A tool executed by OMP is shown as OMP-executed; it is shown as LHIC-verified only when corresponding verifier evidence exists.

## Shared skills

LHIC can optionally synchronize reviewed low-risk skills through the Appwrite-based shared-skill service.

```bash
npx @pinyencheng/lhic shared enable
```

The local cache remains authoritative for Fast Path execution. Registry synchronization does not make an arbitrary remote skill trusted: publication, review, identity, and local eligibility checks remain separate gates.

## Benchmarks and evidence

LHIC includes internal regression benchmarks, deterministic browser resilience fixtures, desktop grounding fixtures, agent-competitive harnesses, and adapters for external benchmark workflows.

Run internal checks:

```bash
npm run bench:internal
npm run bench:simulate -- resilience
npm run bench:agent:self-test
```

Additional benchmark tooling includes:

```bash
npm run bench:webarena:readiness
npm run bench:osworld:bridge:preflight
npm run bench:agent:lhic
npm run bench:agent:goose
npm run bench:agent:codex
npm run bench:agent:validate
npm run bench:evidence:validate
```

### Claim policy

LHIC deliberately separates **implemented benchmark infrastructure** from **official benchmark results**.

Current repository evidence supports claims about the pinned LHIC-controlled fixtures and implemented verification/recovery properties. Official OSWorld, SWE-bench, τ-bench, or similar scores should only be claimed after the corresponding official evaluator has produced a reproducible result with the exact revision, configuration, model, and score recorded.

Do not interpret local competitive suites as proof that LHIC is universally state of the art or universally better than another agent.

See [`docs/sota/claim-matrix.md`](docs/sota/claim-matrix.md) and [`docs/sota/benchmark-methodology.md`](docs/sota/benchmark-methodology.md).

## Repository structure

```text
apps/
  cli/                 command-line interface
  desktop/             Electron Control Center
  lhic/                compatibility entrypoint
  mcp-server/          MCP stdio server

packages/
  browser/             Playwright/CDP execution and browser pooling
  controller/          routing, admission, and task coordination
  game-training/       local training/control contracts
  ledger/              durable action/side-effect records
  memory/              workflow and selector memory
  schema/              shared schemas and contracts
  security/            approvals, KMS, encryption, redaction
  shared-skills/       reviewed skill cache and registry sync
  skills/              browser and desktop skills
  trace/               redacted trace and observability
  verifier/            objective post-action verification

benchmarks/             internal and external benchmark adapters
docs/                   architecture, security, release, and usage docs
services/               optional supporting services
scripts/                CI, release, integrity, and evidence tooling
```

## Security model

LHIC is designed around several boundaries:

1. **Planning is not authority.** A planner or coding agent may suggest work, but LHIC owns admission and policy decisions.
2. **Execution is not verification.** A successful tool return is not automatically verifier evidence.
3. **Verification is explicit.** Evidence is attached to the action or workflow that produced it.
4. **Sensitive data is minimized.** Traces are redacted and credential storage is kept outside ordinary action logs.
5. **Side effects are durable state.** Recovery must account for external effects rather than blindly replaying commands.
6. **Learned behavior earns trust.** Memory and skills are subject to provenance, staleness, evidence, and promotion gates.
7. **Release integrity is checked.** Checksums, SBOM generation, dependency auditing, and fail-closed verification are part of the release path.

For implementation details, start with:

- [`docs/sota/action-receipts.md`](docs/sota/action-receipts.md)
- [`docs/sota/policy-and-approvals.md`](docs/sota/policy-and-approvals.md)
- [`docs/sota/side-effect-recovery.md`](docs/sota/side-effect-recovery.md)
- [`docs/sota/coding-verification.md`](docs/sota/coding-verification.md)
- [`docs/sota/workspace-conflicts.md`](docs/sota/workspace-conflicts.md)
- [`docs/sota/memory-and-learning-trust.md`](docs/sota/memory-and-learning-trust.md)
- [`docs/sota/desktop-grounding.md`](docs/sota/desktop-grounding.md)
- [`docs/sota/release-security.md`](docs/sota/release-security.md)

## Development philosophy

LHIC aims to make capable agents safer and more dependable by improving the part between **intent** and **real-world effect**.

The project therefore prioritizes:

- deterministic execution where possible;
- explicit authority instead of implicit trust;
- evidence over self-reported success;
- recoverable side effects;
- truthful provenance;
- reproducible benchmarks;
- model/provider independence at the control boundary.

The long-term goal is not to replace every planner or coding agent. It is to provide the execution kernel they can safely act through.

## License

See the repository license files for applicable licensing terms.
