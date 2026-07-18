# Desktop Control Center

`apps/desktop` is the Electron + React native control surface for LHIC. It is
an industrial-retro dashboard that leaves the execution runtime local: the
renderer has no Node integration, the preload exposes a fixed IPC allowlist,
and the Electron main process owns Keychain access, CLI processes, local files,
and configuration writes.

## Run locally

```sh
npm run desktop:build
npm run desktop:start
```

Package a development DMG for the host platform with:

```sh
npm run desktop:package
```

The development DMG is complete ad-hoc signed and the package verifier runs
`codesign --verify --deep --strict`, so it cannot silently produce a malformed
application bundle. It is not a distributable macOS release: Gatekeeper will
not trust an ad-hoc signature downloaded from the internet.

Public macOS releases must be signed with a Developer ID Application
certificate and notarized. Provide either `CSC_LINK` or `CSC_NAME`, plus one
supported notarization credential set, and use:

```sh
npm run package:release --workspace @lhic/desktop
```

The release command requires either `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and
`APPLE_API_ISSUER`; `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`; or `APPLE_KEYCHAIN_PROFILE`. It fails before packaging when
these values are absent and runs both code-signature and Gatekeeper assessment
after packaging. Do not upload the development DMG to a public release.

The app's MCP screen detects a supported client, produces the full proposed
configuration, and writes only after confirmation. A detected file receives a
`.lhic-backup` copy before modification. The desktop runs an allowlisted
health probe after apply when a client exposes one; clients without a safe
probe command require an explicit restart and status check.

Slow Path source metadata is stored in `.lhic/task-sources.json` with owner
read/write permissions. It contains no credential values; provider credentials
remain in the operating-system Keychain. Task Console detects installed Codex,
Antigravity, and Claude Code CLIs and can use their existing local sign-in
state; it never reads or automates a third-party password prompt. Every task
tries a matching deterministic Fast Path Skill first. When none matches, an
enabled Slow Path source can propose a redacted `browser-plan-v1` or
`desktop-plan-v1` after user approval. The Fast Path remains model- and
MCP-free.

The Security panel persists only the selected Slow Path budget profile in
`.lhic/security-settings.json` with owner read/write permissions. `fast_only`
admits no provider calls, `balanced` admits one proposal, and `deliberative`
admits at most three proposals for each new task. The setting cannot disable
interactive approval, verifier evidence, PII/credential redaction, or the
model-free Fast Path boundary.

The Skill Depot can also run one of the four allowlisted, read-only public-web
training scenarios. Each run is cancelable and produces a local candidate only
after every declared browser action has verifier evidence. The application
redacts credentials and PII before any Slow Path planning request. A candidate
cannot be promoted or submitted until the existing three independent verified
runs and offline holdout workflow complete.

## Trust boundaries

- Fast Path is deterministic and never invokes an LLM or MCP server.
- Model/CLI sources remain Slow Path proposal sources and action activation
  remains approval- and verifier-gated.
- Slow Path planning requests are admitted through a per-task call, input, and
  wall-clock budget before a provider receives a redacted task description.
- API credentials remain in the OS Keychain. The dashboard does not put them
  in renderer state, browser storage, task events, or traces.
- Custom OpenAI-compatible providers must use public HTTPS and cannot use URL
  credentials or private-network hosts.
- Experimental custom games require a single-player/non-transactional
  attestation, an exact focused window, a bounded input map, a lease, focus
  protection, and emergency stop. Human-play recording never injects input;
  raw frame/input datasets never leave the device. The packaged desktop app
  unpacks the local Python recording worker so it does not depend on a global
  `lhic` installation.
- Built-in game profiles can set up a registered target, fit and evaluate a
  local policy, and run browser playback through a restricted worker bundled
  with the desktop application. Custom profiles remain human-recording-only;
  their raw recordings are never sent to an LLM, remote provider, or external
  service.

## Appwrite Judge Center

The desktop bundle contains only the public Appwrite endpoint, project ID, and
Function URL for the LHIC shared registry. It does not contain API keys, OAuth
secrets, Function encryption keys, or sessions. Deploy the extra control-plane
tables from `appwrite.config.json`, set the Function secrets listed in the
shared-skills service README, and enable GitHub OAuth. The bootstrap Appwrite
account can manage roles, judge allowlists, revocable judge tokens, shared Skill
review, encrypted registry credential metadata, Demo API key configuration, and
evidence assets. Judge access is granted either when the current Appwrite
session's GitHub OAuth identity matches an active provider email or numeric-ID
allowlist, or when an administrator-issued judge token is valid.

Judge Center assets are registered by an administrator in the control plane.
The judge catalog returns only active records, each with a source URL, SHA-256
digest, generated timestamp, and non-sensitive metadata. The renderer must not
create benchmark, latency, or training-quality values itself.

Game policy packages follow a separate review flow. Before submission, the
main process rebuilds the package metadata by re-verifying a deterministic ZIP
that contains only `artifact.json`, policy weights, `policy-package.json`, and
an optional sanitized evaluation report. The control plane records only the
hashes, action codec, version, and credential-free HTTPS bundle URL as
`pending`; it rejects additional fields and never stores raw frames, datasets,
recordings, or keyboard/mouse events. Administrators can approve, reject, or
revoke these entries. GitHub-allowlisted judges receive only approved package
metadata and the supplied HTTPS bundle URL.
