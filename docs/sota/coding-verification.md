# Coding verification

Objective verifier adapters (`packages/verifier/src/coding-verifier.ts`):
`command` (argv arrays, expected exit code, timeout), `git_diff`
(allowed/forbidden paths, max changed files), `file_hash`,
`expected_content`, `diagnostics` (bounded error/warning counts).

Evidence (`lhic-coding-verification-v1`) records verifier version, the
condition, workspace identity, timings, exit code, stdout/stderr digests,
and a bounded PII-redacted excerpt — never full logs, never secrets.
Execution is argument-array only, with enforced timeouts, bounded capture,
and workspace containment (path escapes rejected).

CLI: `lhic verify coding <condition.json> [--workspace <dir>]`. A receipt
may become `verified` only when the required verifier passed with evidence;
execution authority of OMP actions is never relabeled.
