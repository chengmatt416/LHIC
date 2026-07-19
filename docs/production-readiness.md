# Production readiness

This project is a local-first CLI/runtime. A production deployment must pass the following automated gates:

```bash
npm ci
npm run pw:install
npm run ci
LHIC_ENV=production \
  LHIC_ALLOWED_ORIGINS=https://app.example.com \
  npm run preflight
```

## Enforced runtime controls

- Node 24 is required because the skill memory uses `node:sqlite`.
- Production configuration requires an HTTPS origin allowlist and rejects private-network browser targets. Before every HTTP(S) navigation, including redirects, LHIC resolves the hostname and fails closed if any address is private or resolution fails. Enforce matching egress firewall or proxy rules to protect against DNS rebinding after this process-level check.
- The direct executor enforces the risk policy itself: high-risk, unknown-risk, and custom actions require a matching human approval valid for no more than five minutes. It rejects future-dated approvals beyond 30 seconds of clock skew and inspects the resolved control before each click or key press, so an opaque selector cannot bypass policy by being mislabeled low-risk. In production, a high-risk approval must be signed by an external human-approval authority using Ed25519.
- Production executors atomically reserve each accepted approval before dispatch. The reservation survives process restarts until expiry, preventing a signed approval artifact from being replayed.
- Global keyboard and coordinate input require an active-window verifier with an application or title. LHIC verifies that target before dispatch and again after the action, failing closed if focus is wrong.
- DOM and accessibility targets must resolve to exactly one control. LHIC rejects an ambiguous target instead of silently using the first match.
- `fillForm` may verify field values but never submits. Submission must be a separately approved SemanticAction through the executor boundary.
- Downloads and untargeted key presses require a matching human approval, because they can write to local storage or activate whichever control currently has focus.
- `testWebFlow` can execute a side-effecting step only when its caller supplies that step's matching `ActionApproval`.
- Browser actions have bounded default timeouts; `wait` cannot exceed the configured limit.
- Traces are redacted before persistence; production browser executors redact every action value, even when it does not match a generic PII pattern. `lhic trace inspect <file>` reports action reliability, risk distribution, and incomplete actions.
- On POSIX, trace directories are created with mode `0700` and trace files with mode `0600`; trace-file symlinks are rejected. On Windows, configure an equivalent ACL that grants access only to the LHIC service account.
- Multi-path routing is legacy-by-default. Before setting `LHIC_PATH_ROUTING_MODE=enabled`, run it in `shadow` mode, inspect redacted `stage_routed` events, and keep the default `fast_only` profile unless the task explicitly needs a bounded Slow Path budget.
- A Slow Path result is a candidate skill only. It is not Fast Path eligible until three independent verifier-backed executions and a deterministic offline holdout evaluation have passed.
- Candidate compilation parameterizes declared intent constraints before persistence, so equivalent verified runs can accumulate without storing a literal query or other runtime input in the candidate definition.

## Operational requirements outside this repository

- Run the CLI with an OS account that has only the browser/profile permissions it needs.
- Put the trace directory on encrypted storage and configure retention, backup, and incident-access controls.
- Forward the trace summary to the organisation's monitoring system and alert on action failures, incomplete actions, unexpected high-risk activity, and preflight failures.
- Assign a security contact and an incident response owner before public distribution.

The CI workflow runs formatting, type checks, tests, linting, build, the local
regression benchmark, preflight, and a production dependency audit for every
pull request and main-branch push. It also builds the hardened Compose image
and runs its production preflight with an ephemeral Ed25519 public key.

## MCP harness deployment

The browser computer-use MCP server is a stateful local process: one process
owns one Chromium session and serializes its tool calls. Run it on the machine
that is permitted to own that browser, configure the same production runtime
environment as above, and let the AI client keep tool approval prompts enabled.
Do not launch it through `npm run`, because npm lifecycle output would violate
the JSON-only stdio protocol. Use `node apps/mcp-server/dist/index.js` after a
verified build. See [MCP harness integrations](mcp-harnesses.md) for Codex,
Antigravity, Claude Code, and VS Code configuration examples.

Production readiness is separate from market leadership. See [the market-position gate](market-position.md) before making external performance claims.

## Container delivery

Use the checked-in Compose configuration for production preflight. It fails
closed unless both an HTTPS origin allowlist and a readable Ed25519 _public_
key are supplied. The private signing key must never enter the container.

```bash
export LHIC_ALLOWED_ORIGINS=https://app.example.com
export LHIC_APPROVAL_PUBLIC_KEY_HOST_FILE="$PWD/approval-authority-public.pem"
docker compose -f docker-compose.security.yml up --build \
  --abort-on-container-exit --exit-code-from lhic-agent
```

The Compose setup creates a persistent `trace-data` volume with private
permissions before launching the unprivileged runtime. It mounts only the
authority public key as a Docker secret, uses a read-only root filesystem,
drops Linux capabilities, and runs the image's `preflight` command by default.
For action execution, mount only the reviewed action and approval artifacts
read-only and override the command with `run action`. Do not mount browser
profiles, credentials, or host-sensitive paths unless they are explicitly
required and access-controlled. Enforce matching egress firewall or proxy
rules outside the container; Compose cannot provide DNS-rebinding protection on
its own.

## Executing a production action

Supply a JSON `SemanticAction` and, for high-risk work, a matching approval artifact from the approved human-confirmation system. Production startup requires the authority's Ed25519 public key, supplied inline as `LHIC_APPROVAL_PUBLIC_KEY` or as a mounted secret file via `LHIC_APPROVAL_PUBLIC_KEY_FILE`; keep the private key outside this runtime:

```bash
LHIC_ENV=production \
LHIC_ALLOWED_ORIGINS=https://app.example.com \
LHIC_APPROVAL_PUBLIC_KEY="$(cat approval-authority-public.pem)" \
lhic run action action.json [approval.json]
```

The command validates the action before browser launch, then uses `createProductionExecutor`; it cannot bypass navigation policy, timeout limits, trace storage, or high-risk approval checks. Unsigned high-risk approval files, or signatures not verifiable by `LHIC_APPROVAL_PUBLIC_KEY`, are rejected. The repository's signing helper is for the external approval service; do not put that service's private key in the action runtime.
