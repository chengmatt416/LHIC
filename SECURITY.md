# Security policy

LHIC controls browsers and local desktops, so security reports are handled
privately. Do not open a public issue for credentials, approval artifacts,
trace files, personally identifiable information, or an exploitable policy
bypass.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** flow on GitHub. If
that channel is unavailable, contact the maintainers through the private
security contact listed in the repository settings and include:

- the affected version or commit;
- a minimal reproduction and expected versus actual behavior;
- the impact and the access required to reproduce it; and
- any proposed mitigation, without attaching real secrets or customer data.

Please allow maintainers a reasonable remediation window before public
disclosure. We will acknowledge reports, keep the reporter informed, and
credit researchers who want attribution after a fix is available.

## Scope and operational guidance

- Never include real credentials, cookies, approval private keys, or trace
  data in issues, pull requests, tests, or benchmark artifacts.
- Fast Path actions must remain local, policy-controlled, and verifier-backed;
  a model proposal or MCP caller must not bypass the executor boundary.
- Production deployments should run `LHIC_ENV=production lhic preflight`, use
  an HTTPS origin allowlist, keep the approval private key outside the runtime,
  and retain traces on encrypted storage with restricted permissions.
- Dependency and release changes must pass the repository CI gates before
  publication.

This policy describes the project process; it is not a guarantee that every
deployment is secure without the required host, network, and operator
controls.
