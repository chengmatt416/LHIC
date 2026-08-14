# Security

Before a release, run `npm run scan:secrets`. The command scans all reachable
Git history for high-confidence credential formats and redacts every match from
its output. It does not replace a hosted secret scanner, manual review, or key
rotation after a confirmed leak.

- Passwords, tokens, API keys, authorization values, cookie values, emails, and phone-like strings are redacted before trace or memory writes.
- Login never traces raw credentials. CAPTCHA and 2FA are explicit `askUser` outcomes.
- High-risk, unknown-risk, and unapproved custom actions are not eligible for Fast Path execution.
- The executor independently validates that high-risk actions carry a matching, expiring human approval; callers cannot bypass this through direct SDK use. In production, the artifact must also carry a valid Ed25519 signature from the configured external approval authority.
- Production navigation requires an HTTPS origin allowlist and rejects private-network targets, URL credentials, and non-HTTP(S) protocols. HTTP(S) navigation hosts are resolved before dispatch and on redirects; unresolved or privately resolved hosts fail closed. Pair this check with egress firewall or proxy rules to protect against DNS rebinding.
- CLI action files are treated as untrusted input: action type, non-empty intent, target shape, execution methods, and risk level are validated before a browser is launched.
- Every successful skill exposes verifier evidence. If a success condition is unavailable, the skill reports that gap instead of claiming completion.
- Claude and GPT-5.6 Slow Path providers are disabled by default. When enabled, their requests are redacted before transmission and credentials are never included in the payload. The GPT-5.6 provider uses the Responses API with `store: false`, a strict JSON Schema response, a bounded timeout, and post-response semantic-action validation.
- The Antigravity computer-use MCP server exposes only start, observe, act, and close browser tools. It omits form input values from observation responses, redacts tool output, and delegates every action to the existing navigation, approval, trace, and verifier boundaries.

Redaction is a defense-in-depth control, not permission to collect sensitive input unnecessarily. Callers should pass the minimum information required to perform an action.

## omp binary trust and version policy

The agent runs the omp coding kernel as a supervised child process. The binary
is a supply-chain boundary, so it is never executed unverified:

- **Verified identity.** Every resolution path — cache, download, bundled
  packaging, or `OMP_BINARY` override — returns a `VerifiedOmpBinary` with the
  measured SHA-256, the version it corresponds to, and the trust source
  (`explicit-digest`, `explicit-operator`, `trusted-record`, or
  `release-manifest`). A raw path is never returned from pinned mode.
- **Trusted digest record.** The first time a cached version passes a release
  SHA-256 manifest check, LHIC writes a permission-restricted record
  (`<cache>/<version>/trusted.json`, mode `0600`, directory `0700`) that binds
  the version, asset name, and digest together. A record moved from another
  version directory is rejected.
- **Digest-immutable records.** A version's trusted digest never rotates
  silently: a release-manifest verification that would change an existing
  record fails closed instead of overwriting it. Only an explicit
  administrative pin (a `pinned` policy digest) may replace a record.
- **Fail closed offline.** With no network, a cached omp binary runs only when
  it matches its trusted digest record. A tampered cache, a cache without a
  trust record, or a missing cache all fail startup offline instead of
  executing an unverified binary.
- **`OMP_BINARY` overrides are verified.** The override's SHA-256 is always
  measured and checked against the pinned policy digest or
  `OMP_BINARY_DIGEST`; a version conflict with the pin fails. Without any
  digest, the override is rejected unless `OMP_BINARY_TRUST=explicit-operator`
  or `development-only` explicitly authorizes it, and a pinned policy always
  requires a digest.
- **Bundled binaries must match the pin.** In pinned mode a bundled binary is
  verified against the pinned digest; a pinned policy without a digest
  refuses a bundled binary rather than running it unverified. The packaged
  desktop app verifies its vendor omp against the release SHA-256SUMS at build
  time (`apps/desktop/scripts/fetch-omp.mjs`) and ships the verified binary.
- **Version policy.** `pinned` runs exactly one version and never checks for
  updates; an optional digest additionally anchors the executable. `managed`
  (the default) ensures the pinned version and applies newer stable releases
  subject to the RPC compatibility gate. `development-latest` is for local
  development only. Benchmark and release runs MUST pin.
- **Protocol compatibility gate.** At RPC startup LHIC negotiates the protocol
  from the server's advertised versions; protocol v2 requires a server
  acknowledgement before startup completes. Servers with no version overlap
  are rejected, an omp binary that explicitly reports host tools disabled is
  rejected, and capability failures are fatal (never retried by the crash
  supervisor). Optional capabilities absent from the advertisement are
  reported as `unknown`, never assumed supported.
- **Malformed frames are rejected.** RPC chunk reassembly uses fatal UTF-8
  decoding; malformed frames are dropped, never decoded with replacement
  characters.
