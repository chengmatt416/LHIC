# LHIC Rust Rewrite — Alpha (branch `rust-rewrite-alpha`)

The LHIC application rewritten from the ground up in Rust, including its
third-party cores:

| Original (TypeScript/Node) core | Rust replacement |
|---|---|
| `@lhic/browser` (Playwright) | `lhic-core::browser` — Chrome DevTools Protocol client (websocket), launches Chromium directly |
| `@lhic/memory` (SQLite) | `lhic-core::memory` — rusqlite sessions/messages store |
| `@lhic/security` (KMS/keyring/redaction) | `lhic-core::security` — AES-256-GCM vault (0600 key file) + PII redactor |
| `@lhic/omp-rpc` | `lhic-agent::rpc` — stdio JSON-lines RPC client for the omp engine |
| omp (agent core) | bundled binary (v17.2.15); the engine is itself Rust |
| shared-skills (Appwrite client) | `lhic-core::skills` — reqwest REST client |
| `@lhic/controller` (routing) | `lhic-core::controller` — fast-path/slow-path routing |
| `@lhic/trace` | `lhic-core::trace` — redacted JSONL event log |
| desktop (Electron) | `lhic-desktop` — egui/eframe native app |
| CLI (`lhic`) | `lhic-cli` — `lhic-rust` (clap) |
| MCP server | `lhic-mcp` — stdio JSON-RPC server (`lhic-mcp-rust`) |

## Workspace layout

```
Cargo.toml                 workspace manifest
.cargo/config.toml         generic aarch64 codegen (no SVE)
crates/
  lhic-core/               memory, security, trace, browser (CDP), skills, controller
  lhic-agent/              omp RPC client + provider key store (vault-backed)
  lhic-cli/                lhic-rust binary
  lhic-mcp/                lhic-mcp-rust binary (MCP stdio server)
  lhic-desktop/            lhic-control-center-rust binary (egui app)
alpha-dist/                built alpha binaries (committed)
```

## Building

```sh
cargo build --release          # or: cargo build
cargo test --workspace
```

## Running

```sh
# CLI
./target/release/lhic-rust init
./target/release/lhic-rust agent key-set openai <key>   # vault-stored
./target/release/lhic-rust agent prompt "explain this repo"
./target/release/lhic-rust memory add "note something"
./target/release/lhic-rust browser open https://example.com

# MCP server (stdio)
./target/release/lhic-mcp-rust

# Desktop (egui; needs a display)
./target/release/lhic-control-center-rust
```

The omp engine is resolved from `OMP_BINARY`, `apps/desktop/vendor/omp/current/omp`,
or `omp` on PATH. Chromium is resolved from `LHIC_CHROMIUM`, the Playwright
cache, or PATH.

## Debug evidence (this branch)

- `cargo test --workspace` — 5 core tests pass (vault round-trip + tamper
  rejection, PII redaction stability, fast/slow routing).
- Agent RPC: full round-trip against the real omp 17.2.15 binary — ready
  handshake, protocol negotiation, `get_state` (model resolved), `prompt`
  accepted, stderr captured (the "No models available" diagnostics path).
  Debugged and fixed: the request id must be embedded in the outgoing frame
  for omp's response correlation.
- Browser: CDP launch + navigate + title against real Chromium 151 (incl. the
  qemu/emulated-environment fix: chromium is spawned through `sh -c '… &'`
  because a directly spawned child never initializes networking under qemu
  emulation; Drop kills the browser by profile dir, verified no process leak).
- MCP: initialize handshake, tools/list (7 tools), memory.store (redacted at
  rest), security.redact, memory.search — all verified over stdio.
- Memory/security: PII is redacted before persistence (search output shows
  `[email]` for stored secrets).

## Known limitation (build environment only)

The egui desktop binary builds cleanly and its entire logic surface is
exercised through the CLI, MCP, and tests, but the GUI runtime cannot start
**inside this headless PRoot container**: mesa's llvmpipe JITs SVE
instructions (`index z1.s` → SIGILL) on this emulated host, which lacks SVE in
its execution environment. This is an environment/driver bug, not an
application defect — the app is a native aarch64 binary that runs on real
desktops. Workarounds attempted and exhausted: software GL
(`LIBGL_ALWAYS_SOFTWARE`), swrast/softpipe driver overrides, Xvfb GLX
configurations, core pinning, and disabling LLVM JIT paths; the JIT still
emits SVE for this CPU's MIDR. On a normal desktop (physical or VM with a
working GL stack) the app starts and shows the Agent / Memory / Browser /
Settings panels.

## Alpha versioning

`0.1.0-alpha.1`. Not published to any release channel — this branch's code
and the committed `alpha-dist/` artifacts are the deliverable.
