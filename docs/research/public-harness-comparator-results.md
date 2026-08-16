# Real Public-Harness Comparator Results — PRELIMINARY / SUPERSEDED

> **Do not use this experiment as the primary paper, deck, or benchmark evidence.** The executions and archived GitHub Actions artifacts below are real, but the comparison has an important fairness asymmetry: LHIC was given an explicit stable `actionId`, while Codex and Goose only received the same shell command and a new protocol-level tool-call ID. The Goose installer path also resolved a moving `stable` release internally. This experiment is retained for provenance only. The replacement is `experiments/fair-harness-comparator/`, where all three systems consume the same SHA-verified plan, the stable logical action ID is visible in the identical command payload, binaries are version-pinned, controls are explicit, and a one-command reproducer is provided.

These results are **controlled execution-layer experiments**, not public benchmark scores and not a comparison of planner intelligence.

## Question

If a tool has already committed a durable side effect but then reports an error, and the planner subsequently proposes the **same logical action** again, does the execution harness permit a second physical dispatch?

The experiment compares:

- **OpenAI Codex CLI 0.147.0** using its official `exec_command` tool;
- **Goose 1.46.0** using its official built-in `developer` extension and `shell` tool;
- **LHIC-Core** from `research/lhic-core-academic`.

A local deterministic Responses-compatible provider fixes planner behavior so the comparison is about harness execution semantics rather than model quality.

## Fixture

Every condition uses the same `effect.py` durable side effect. The script atomically increments a JSON state counter and fsyncs the result.

### No-fault control

```text
planner issues logical action
    -> tool runs effect.py
    -> durable count becomes 1
    -> tool exits 0
    -> planner finishes
```

This checks that all harnesses can execute the fixture normally and do not duplicate it without a failure signal.

### Post-commit-error condition

```text
planner issues logical action
    -> tool runs effect.py
    -> durable count becomes 1
    -> tool exits 17 AFTER the commit
    -> harness returns the failure to the planner
    -> deterministic planner proposes the identical logical action again
    -> measure whether a second physical dispatch occurs
```

This is intentionally described as a **post-commit tool error**, not a lost-response experiment. The public harness receives a failure result. The experiment asks whether the execution layer independently recognizes or blocks a duplicate logical side effect when the planner asks again.

For Codex and Goose, the second request uses a new protocol call ID but the **same command and same state target**. For LHIC-Core, both planner proposals carry the same stable `actionId`, so the execution layer can reason about action identity independently of model/tool-call IDs.

## Primary validated run

- branch: `research/lhic-core-academic`
- implementation / evidence commit: `9c069efed8155e41fca90dd8b531ff5b37b72f9a`
- workflow: `Public Harness Comparator`
- workflow run: `31949135023`
- environment: GitHub Actions Ubuntu 24.04
- trials: 10 per condition per harness = 60 total controlled trials

Evidence artifacts:

| Artifact | ID | SHA-256 digest |
|---|---:|---|
| Combined summary | `9264141236` | `0088288244577d3b2af31675a4175468fe811717f1d545874a1c97550da3deb6` |
| Codex raw trials | `9264138848` | `58e45d020286d8db3c7baa3e9e8d91929c5220255fe3ca3fa148ed284656c0e8` |
| Goose raw trials | `9264138498` | `469dfc0c349fa548bf59a6727c47587ea2db11096374243f50a25496a40de2b1` |
| LHIC raw trials | `9264134110` | `dd6f6dc504c9ad7dac931978442485ec6418c20c09698316418c55c4bd15e2a1` |

## Results

### No-fault control

| Harness | Valid trials | Trials with second physical dispatch | Duplicate side effects | Mean physical side effects |
|---|---:|---:|---:|---:|
| Codex CLI 0.147.0 | 10 / 10 | 0 / 10 | 0 | 1.0 |
| Goose 1.46.0 | 10 / 10 | 0 / 10 | 0 | 1.0 |
| LHIC-Core | 10 / 10 | 0 / 10 | 0 | 1.0 |

All three harnesses behave identically in the no-fault control: exactly one physical side effect per trial.

### Post-commit tool error + identical planner retry

| Harness | Valid trials | Trials with second physical dispatch | Duplicate side effects | Mean physical side effects |
|---|---:|---:|---:|---:|
| **Codex CLI 0.147.0** | 10 / 10 | **10 / 10** | **10** | **2.0** |
| **Goose 1.46.0** | 10 / 10 | **10 / 10** | **10** | **2.0** |
| **LHIC-Core** | 10 / 10 | **0 / 10** | **0** | **1.0** |

LHIC-Core's durable ledger reached `verified` in 10 / 10 no-fault trials and 10 / 10 post-commit-error trials.

## Raw trace check

The public-harness raw traces show that the second physical effect is executed by the real harness tool path, not by the experiment driver.

### Codex example

1. provider issues `exec_command` with the effect command;
2. Codex runs it and returns `Process exited with code 17` plus `SIMULATED_POST_COMMIT_ERROR count=1`;
3. the deterministic planner issues the same `exec_command` again;
4. Codex runs it again and returns `SIMULATED_POST_COMMIT_ERROR count=2`.

### Goose example

1. provider issues the built-in `developer.shell` action;
2. Goose returns `Command exited with code 17` plus `SIMULATED_POST_COMMIT_ERROR count=1`;
3. the deterministic planner issues the same `shell` command again;
4. Goose runs it again and returns `SIMULATED_POST_COMMIT_ERROR count=2`.

### LHIC example

1. LHIC physically dispatches the same `effect.py` fixture once;
2. the tool reports the post-commit error;
3. LHIC independently verifies that exactly one intended effect exists and durably marks the action `verified`;
4. when the retry-oriented planner proposes the same stable logical action again, no second physical dispatch occurs.

## Repeatability

An earlier workflow execution (`31948996689`, commit `75a016ca8fc23454d040f9f2780cb302a57f2336`) produced the same aggregate outcome:

- Codex: 10 / 10 second-dispatch trials in the post-commit-error condition;
- Goose: 10 / 10;
- LHIC-Core: 0 / 10;
- all three: 0 / 10 second dispatches in the no-fault condition.

Between the earlier run and the primary run, the public-harness comparator logic was unchanged; the later commit only refined LHIC evidence logging to expose the durable ledger state. This is repeatability evidence, not an exact-SHA rerun.

Earlier combined artifact:

- artifact ID: `9264105067`
- digest: `3f7862601ac5b402f1bca3cc152ecf3f23e3ca365c3c517592db37740f2684b3`

## Historical claim only — do not promote

The original text below was the claim boundary before the fairness issue was identified. It is retained only so the research record explains what was previously presented; use the replacement fair comparator before making any named-harness claim.

> Under a controlled post-commit tool-error fixture with a fixed retry-oriented planner, official Codex CLI 0.147.0 and Goose 1.46.0 both physically dispatched the identical logical shell side effect a second time in 10/10 trials, while LHIC-Core blocked the second physical dispatch in 10/10 trials after independently verifying the first committed effect. All three harnesses executed exactly once in the matched no-fault control.

## What this does **not** support

This experiment does not show that:

- Codex or Goose autonomously choose to retry more often in normal use;
- their planner models are worse than LHIC;
- LHIC has higher general task-completion accuracy;
- LHIC is faster overall;
- LHIC beats either system on OSWorld, WebArena, SWE-bench, or another public benchmark;
- every error or side-effect class will show the same outcome.

The planner is deliberately fixed. The measured difference is the **execution harness's treatment of a repeated logical action after a post-commit error**.

## OpenHands

OpenHands is not included in the result table because it was not executed in this validated workflow. It must not be shown as a measured comparator until an equivalent official runtime path is run and archived.