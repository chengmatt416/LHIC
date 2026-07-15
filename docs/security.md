# Security

- Passwords, tokens, API keys, authorization values, cookie values, emails, and phone-like strings are redacted before trace or memory writes.
- Login never traces raw credentials. CAPTCHA and 2FA are explicit `askUser` outcomes.
- High-risk, unknown-risk, and unapproved custom actions are not eligible for Fast Path execution.
- The executor independently validates that high-risk actions carry a matching, expiring human approval; callers cannot bypass this through direct SDK use. In production, the artifact must also carry a valid Ed25519 signature from the configured external approval authority.
- Production navigation requires an HTTPS origin allowlist and rejects private-network targets, URL credentials, and non-HTTP(S) protocols.
- CLI action files are treated as untrusted input: action type, non-empty intent, target shape, execution methods, and risk level are validated before a browser is launched.
- Every successful skill exposes verifier evidence. If a success condition is unavailable, the skill reports that gap instead of claiming completion.
- Claude Slow Path is disabled by default. When enabled, its request is redacted before transmission and credentials are never included in the payload.

Redaction is a defense-in-depth control, not permission to collect sensitive input unnecessarily. Callers should pass the minimum information required to perform an action.
