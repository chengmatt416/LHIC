# OSWorld 2.0 Adapter Scaffold

This directory starts the external-validity layer for LHIC-Core.

It is intentionally a **runner interposition scaffold**, not an OSWorld score and not a forked evaluator.

## Release pin

For reproducible evaluation, use the supported OSWorld 2.0 release:

```text
OSWorld-V2 code: xlang-ai/OSWorld-V2@v2026.06.24
benchmark release: osworld-v2-2026.06.24
```

Do not evaluate against the moving `main` branch and do not mix task/assets/web releases.

Primary source:

- https://github.com/xlang-ai/OSWorld-V2

## Where LHIC belongs

The OSWorld runner obtains planner output through an agent method such as:

```python
response, actions = agent.predict(instruction, obs)
```

and then executes each action through a call equivalent to:

```python
obs, reward, done, info = env.step(action, args.sleep_after_execution)
```

LHIC-Core should be inserted **between those two operations**:

```text
planner / agent.predict
        |
        v
proposed pyautogui action
        |
        v
LHIC boundary
  - action identity
  - risk / policy
  - approval scope if relevant
  - persist possibly_committed
        |
        v
official env.step(...)
        |
        +---- returned ----------> execution evidence only
        |
        +---- exception/timeout -> ambiguous recovery path
```

The official OSWorld environment setup, task specification, step budget, and evaluator remain unchanged.

## Files

- `runner_boundary.py` — minimal benchmark-side interposition hook.
- `test_runner_boundary.py` — verifies ordering and failure reporting without requiring OSWorld images.

The Python scaffold deliberately does **not** reimplement the TypeScript LHIC state machine. A bridge must implement `BoundaryClient` using the research kernel or product runtime.

## Critical benchmark discipline

1. **Do not change official scoring.** LHIC execution metrics are reported alongside, not instead of, OSWorld scores.
2. **Do not call `env.step` before ambiguity is durably persisted.**
3. **Do not call an OSWorld return value “LHIC verified.”** A successful `env.step` is execution evidence, not an independent postcondition verifier.
4. **Do not silently retry after an exception/timeout.** The boundary must recover from durable state and re-observe before any replay decision.
5. **Preserve the planner.** For runtime ablation experiments, planner/model configuration, instruction, environment image, task, and budget must remain fixed.
6. **Pin the benchmark release.** Code, tasks, assets, and mocked websites must come from the same OSWorld release.

## First integration milestone

The first benchmark-facing experiment should compare the **same planner** under:

- vanilla OSWorld runner;
- LHIC logging-only boundary;
- LHIC durable ledger + re-observation;
- full LHIC-Core boundary.

Report official task score separately from:

- duplicate side effects;
- ambiguous outcomes;
- recovered actions;
- unresolved `needs_resolution` actions;
- additional observations;
- added latency;
- verifier calls.

## Running the scaffold test

From this directory:

```bash
python3 -m unittest -v test_runner_boundary.py
```

Passing this test only validates interposition ordering. It does not establish OSWorld compatibility until the scaffold is exercised inside the pinned OSWorld runner and environment.
