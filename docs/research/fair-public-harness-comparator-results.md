# Fair Reproducible Public-Harness Comparator Results

## Status

This is the **primary named public-harness comparator evidence**. It supersedes `docs/research/public-harness-comparator-results.md`, whose executions were real but whose design gave LHIC an asymmetric stable action-identity channel.

These results are a controlled execution-semantics experiment. They are **not** a public benchmark score, a planner-intelligence comparison, or a claim that Codex/Goose normally choose to retry more often.

## Exact final validated run

- branch: `research/lhic-core-academic`
- exact implementation/evidence SHA: `c9f80528c78615ae7f9ee82fb554a1e826f8d988`
- workflow: `Fair Public Harness Comparator`
- workflow run ID: `31952588633`
- job ID: `95178256598`
- result: `success`
- runner: GitHub Actions `ubuntu-24.04`
- Node: `v22.23.2`
- Python: `3.12.3`
- npm: `10.9.8`
- working tree in evidence metadata: clean
- total trials: 3 harnesses × 4 conditions × 10 trials = **120**

Evidence artifact:

- artifact ID: `9265081573`
- artifact name: `fair-public-harness-comparator-evidence`
- artifact SHA-256 digest: `cc1494301f3cb27b515a5bf4d51e62658652e02f956199390a8adb054b8f26e5`
- fixture manifest SHA-256: `0063215e3c8a457be0158466d8dc89017a121b1d374da0d6679cb607c76477d5`
- combined-summary SHA-256: `64b26a291e2c02f39169a525d72c222860e97b13c919494ea42603714c88cb28`
- rendered `RESULTS.md` SHA-256: `32100ff64a3051c0131fa262283b7744714b63cfebc681bc00daada27db202c7`

The final run uses a **committed npm lockfile + `npm ci`** for Codex. The committed reproducibility inputs have SHA-256:

- `codex-package.json`: `dc1ccdae0215eb124599229dc903aab1a013cbebe884cb6ade12b462a68588ff`
- `codex-package-lock.json`: `4eb38050c8def847e9df40ddd4c55f58e52d72c5c12d75e91c2a8b5aa9f0e032`

## Reproduction

From the exact commit on Linux x86_64 with Python 3, Node/npm, curl, tar, and `sha256sum`:

```bash
bash experiments/fair-harness-comparator/reproduce.sh --trials 10
```

The reproducer needs no model/API credentials. It installs/pins:

- OpenAI Codex CLI `0.147.0` from the **committed npm package manifest and integrity lock**, using `npm ci` in an isolated temporary prefix;
- Goose `v1.46.0` using the exact official `goose-x86_64-unknown-linux-gnu.tar.bz2` release asset and verifies archive SHA-256 `a1cf4856a765d07d6b95689a53c7bca21fcc6e6d65c0dfd064fc704052b85a7b` before extraction.

The evidence archive records the actual executed versions:

- Codex: `codex-cli 0.147.0`;
- Goose: `1.46.0`.

## Fairness contract

All three harnesses consume the same generated fixture manifest. Before aggregation, the experiment asserts equality of the tuple:

```text
(condition,
 trial,
 planSha256,
 logicalActionIds,
 commandSha256s)
```

across Codex, Goose, and LHIC-Core.

The primary same-ID condition gives all three systems the same stable logical action identity **inside the exact command payload**:

```text
--logical-action-id fair:post_commit_error_same_id:<trial>:A
```

Proposal 1 and proposal 2 have the same logical ID and byte-identical command SHA-256. The native execution transports remain intentionally native:

- Codex: official `exec_command` tool;
- Goose: official built-in `developer.shell` tool;
- LHIC-Core: research kernel + shell adapter.

The deterministic local provider does not issue proposal 2 blindly. It first validates from the real harness request history that:

1. the first tool call contains the exact expected command;
2. the harness returned the `FAIR_EFFECT_RESULT` marker emitted by the real effect process;
3. the marker contains the expected logical action ID, mode, and downstream-idempotency setting;
4. the harness output reports exit code 17.

Only then is the next proposal issued. Any mismatch emits `fixture_invalid` and makes the trial invalid.

## Fixture controls

The fixture has its own direct self-test before any harness is compared:

- same ID + downstream idempotency OFF + two direct invocations → 2 attempts, 2 commits;
- same ID + downstream idempotency ON + two direct invocations → 2 attempts, 1 commit;
- different IDs + downstream idempotency ON → 2 attempts, 2 commits.

The validated run reports `fair fixture self-test: PASS`.

The aggregate hard gates also passed:

- all 120 trials infrastructure-valid: **PASS**;
- no-fault control: **PASS**;
- downstream-idempotency control: **PASS**;
- identical fixture identity across all harnesses: **PASS**.

## Results

### 1. No-fault control

All three harnesses execute exactly once in all 10 trials.

| Harness | Valid | Second physical dispatch | Duplicate committed effects | Mean physical dispatches |
|---|---:|---:|---:|---:|
| Codex CLI 0.147.0 | 10/10 | 0/10 | 0 | 1.00 |
| Goose 1.46.0 | 10/10 | 0/10 | 0 | 1.00 |
| LHIC-Core | 10/10 | 0/10 | 0 | 1.00 |

### 2. Primary condition: post-commit error + same logical action ID

The first effect commits durably, the tool exits 17, the deterministic planner then proposes the same logical ID and the same command again.

| Harness | Valid | Same-ID second physical dispatch | Duplicate committed effects | Mean physical dispatches |
|---|---:|---:|---:|---:|
| Codex CLI 0.147.0 | 10/10 | **10/10** | **10** | 2.00 |
| Goose 1.46.0 | 10/10 | **10/10** | **10** | 2.00 |
| LHIC-Core | 10/10 | **0/10** | **0** | 1.00 |

In the archived LHIC trial state, the first execution is independently verified and the durable ledger is `verified`; the second same-ID proposal does not produce a second physical process invocation.

### 3. Negative identity control: post-commit error + new logical action ID

Proposal 2 is a different logical action identity. All three systems physically execute it.

| Harness | Valid | Second physical dispatch | Duplicate committed effects | Mean physical dispatches |
|---|---:|---:|---:|---:|
| Codex CLI 0.147.0 | 10/10 | **10/10** | 0 | 2.00 |
| Goose 1.46.0 | 10/10 | **10/10** | 0 | 2.00 |
| LHIC-Core | 10/10 | **10/10** | 0 | 2.00 |

This control matters because it shows LHIC is not simply blocking every second action after an error. Changing the stable identity changes the execution decision.

### 4. Downstream-idempotency control: same logical ID

Here the downstream effect independently deduplicates repeated action IDs.

| Harness | Valid | Same-ID second physical dispatch | Duplicate committed effects | Downstream-suppressed second attempts |
|---|---:|---:|---:|---:|
| Codex CLI 0.147.0 | 10/10 | **10/10** | 0 | 10 |
| Goose 1.46.0 | 10/10 | **10/10** | 0 | 10 |
| LHIC-Core | 10/10 | **0/10** | 0 | 0 |

This proves the experiment distinguishes **dispatch attempts** from **committed duplicate side effects**. Codex/Goose still invoke the physical effect process twice; downstream idempotency suppresses the second commit. LHIC prevents the second physical dispatch before it reaches the downstream effect.

## Example primary-trial identity

For primary trial 01, all three archived result files report:

- plan SHA-256: `cb51bbdbb7d24566c878cac27e6b6a397e737ac2e6d03610fce957bed2cdd03c`;
- logical action IDs: `fair:post_commit_error_same_id:01:A` for both proposals;
- command SHA-256: `4c77b9e43ef020c26fe3d2e5dd5ce7d9f7a5bc13401cc514d44e7dd28be98004` for both proposals.

The Codex and Goose raw provider traces both record proposal 1, a validated real tool result with `committedCount: 1` and exit 17, proposal 2 with the same command, and then a second real tool result with `committedCount: 2`.

The LHIC result records two planner proposals but only one adapter/physical dispatch, with one committed effect and a durable verified ledger entry.

## Repeatability

The immediately preceding fair run, before converting Codex installation from a runtime-generated lock to the committed lock + `npm ci`, also passed all 120 trials with **identical experimental outcomes**:

- run ID: `31952358477`
- SHA: `71c7b2aa8b6c779880b13e26d1ff30b1695ab737`
- artifact ID: `9265018931`
- artifact digest: `dd194d25dbbb03675a81918cc8e809b406dfb95dbd3133142286d4ef0622f067`

A direct diff of the two combined summaries changes only temporary installation paths and the LHIC Git SHA. The per-condition result metrics are unchanged. `RESULTS.md` is byte-identical between the two runs, with SHA-256 `32100ff64a3051c0131fa262283b7744714b63cfebc681bc00daada27db202c7`.

## Defensible claim

> Under a SHA-verified controlled post-commit-error fixture where Codex CLI 0.147.0, Goose 1.46.0, and LHIC-Core receive the same stable logical action ID and byte-identical retry command, Codex and Goose each performed a second physical dispatch in 10/10 trials, while LHIC-Core performed no second physical dispatch in 10/10 trials. A new-ID negative control caused LHIC to dispatch the second action in 10/10 trials, and a downstream-idempotency control separately confirmed that the experiment distinguishes second dispatch from duplicate commit.

## Claim boundary / remaining limitations

This still does **not** establish that:

- Codex or Goose autonomously choose to retry more often under their normal model/planner behavior;
- LHIC is a better coding agent or planner;
- LHIC has higher task-completion accuracy;
- LHIC beats either system on OSWorld, SWE-bench, WebArena, or another official benchmark;
- every action type or failure mode exhibits the same behavior;
- the public harnesses are expected to understand an application-level logical action ID embedded in a shell command. The experiment measures their **stock execution-layer behavior when the same identified action is proposed again**, not whether an added external idempotency middleware could be built for them.

The comparison is therefore narrowly about execution-layer duplicate-dispatch prevention under this controlled identified-action scenario.
