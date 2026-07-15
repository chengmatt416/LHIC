# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in ComputerIntent, please report it privately.

**Do not open a public GitHub issue.** Instead, send a detailed report to:

- **Email**: chengmatt416@gmail.com
- **Alternative**: Use the [GitHub Security Advisory](https://github.com/chengmatt416/ComputerIntent/security/advisories/new) form.

Please include:

- A description of the vulnerability
- Steps to reproduce
- Affected versions
- Any potential impact or exploit scenario

You should receive a response within 48 hours. If you don't, please follow up.

## Scope

The following are in scope:

- PII/credential leakage through trace or memory persistence
- Bypass of the risk policy or human-approval requirement
- Bypass of the production origin allowlist
- Injection attacks through CLI action files
- Unauthorized access to browser profiles or stored credentials

The following are **out of scope** (defense-in-depth, not a security boundary):

- Redaction failures where the caller intentionally passes sensitive data
- Vulnerabilities in Playwright itself (report those to the Playwright project)
- Vulnerabilities in Node.js itself

## Security Invariants

1. Passwords, tokens, API keys, authorization values, cookie values, emails, and phone-like strings are redacted before trace or memory writes.
2. Login never traces raw credentials. CAPTCHA and 2FA are explicit `askUser` outcomes.
3. High-risk, unknown-risk, and unapproved custom actions are not eligible for Fast Path execution.
4. The executor independently validates that high-risk actions carry a matching, expiring human approval; callers cannot bypass this through direct SDK use.
5. In production, the approval artifact must carry a valid Ed25519 signature from the configured external approval authority.
6. Production navigation requires an HTTPS origin allowlist and rejects private-network targets, URL credentials, and non-HTTP(S) protocols.
7. CLI action files are treated as untrusted input: action type, non-empty intent, target shape, execution methods, and risk level are validated before a browser is launched.
8. Every successful skill exposes verifier evidence. If a success condition is unavailable, the skill reports that gap instead of claiming completion.
9. Claude Slow Path is disabled by default. When enabled, its request is redacted before transmission and credentials are never included in the payload.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Active development |

## Disclosure Policy

We follow a 90-day disclosure window. After a fix is released, we will publish a security advisory describing the issue and the fix.

## Recognition

We thank all security researchers who follow responsible disclosure practices.
