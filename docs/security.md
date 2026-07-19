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
