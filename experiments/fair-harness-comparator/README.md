# Fair Public-Harness Comparator

This directory is the **reviewable/reproducible replacement** for the earlier preliminary public-harness comparator.

## Why a replacement was necessary

The preliminary experiment executed real Codex and Goose binaries, but it was not strong enough for a paper/deck claim because LHIC received an explicit stable `actionId` while the public harnesses only saw an identical command with new protocol call IDs. It also installed Goose through a release installer that could resolve a moving `stable` asset. Those runs are retained for provenance but should not be used as the main comparator evidence.

## Fairness contract

The replacement holds the following constant across Codex, Goose, and LHIC-Core:

- the **same generated `plan.json` bytes** (verified by SHA-256);
- the **same logical action ID**, visible in the command as `--logical-action-id`;
- the **same exact shell command string** for the primary same-ID condition;
- the **same state path** on a fresh/reset local fixture;
- the **same durable `effect.py` implementation**;
- the **same deterministic planner policy**: proposal 2 is issued only after the harness returns a validated exit-code-17 result for proposal 1;
- the **same host runner** in the CI workflow;
- no external model/API key.

The native execution transports are intentionally not made identical: Codex uses its official `exec_command`, Goose uses the official built-in `developer.shell`, and LHIC uses its research kernel + shell adapter. That native harness behavior is the treatment being compared.

## Conditions

1. `no_fault`: one logical action, normal exit. Sanity control.
2. `post_commit_error_same_id`: the durable effect commits, exits 17, then the planner proposes the **same ID + same command** again. Primary comparator.
3. `post_commit_error_new_id`: identical failure, but retry uses a **new logical action ID**. Negative identity control; LHIC must not behave like a global lock.
4. `post_commit_error_same_id_downstream_idempotent`: same-ID retry, but the downstream effect independently deduplicates by logical ID. This separates *second physical dispatch* from *duplicate committed side effect*.

## One-command reproduction

On Linux x86_64 with Python 3, Node/npm, curl, tar, and sha256sum:

```bash
bash experiments/fair-harness-comparator/reproduce.sh --trials 10
```

The script downloads no model and needs no credentials. It installs:

- `@openai/codex@0.147.0` into an isolated temporary prefix and archives the generated npm lockfile;
- Goose `v1.46.0` from the exact `goose-x86_64-unknown-linux-gnu.tar.bz2` release asset, checked against SHA-256 `a1cf4856a765d07d6b95689a53c7bca21fcc6e6d65c0dfd064fc704052b85a7b`.

Outputs are written to `artifacts/fair-harness-comparator/`, including raw provider requests, tool outputs, per-trial state, LHIC ledgers, environment metadata, summaries, and hashes.

## Claim boundary

This can support a statement about **execution-layer treatment of a repeated stable logical action after a visible post-commit tool error**. It does not compare planner intelligence, normal retry propensity, OSWorld/SWE-bench task quality, or the separate lost-response/crash experiment.
