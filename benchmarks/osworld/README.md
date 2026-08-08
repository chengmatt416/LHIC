# OSWorld 2.0 official harness bridge

This integration targets the official `xlang-ai/OSWorld-V2` release
`osworld-v2-2026.06.24`. The official Python harness remains the sole owner of
`DesktopEnv`, VM provisioning, `reset`, `step`, recording, and evaluation. LHIC
only receives an accessibility observation, asks the configured `TaskSource`
for one executor-compatible `GlobalComputerAction`, converts the supported
subset to OSWorld's `computer_13` schema, and returns it. It never writes a
score or reports a proposed action as successful.

## Required configuration

Copy `config.example.json` outside the repository if secrets or private paths
will be added. Keep `benchmarkRevision`, the official checkout/tag, downloaded
task classes/assets, and website release identical. HTTP model sources also
require `credentialEnv`; the named environment variable must contain the key.
CLI sources use their existing authenticated CLI session.

```bash
export LHIC_OSWORLD_BRIDGE_CONFIG="$PWD/benchmarks/osworld/config.example.json"
export LHIC_OSWORLD_BRIDGE_COMMAND_JSON="[\"$PWD/node_modules/.bin/tsx\",\"$PWD/benchmarks/osworld/lhic_osworld_bridge.ts\"]"
export LHIC_OSWORLD_BENCHMARK_REVISION=osworld-v2-2026.06.24
export LHIC_OSWORLD_SEED=20260624
```

The adapter fails closed when Node is not version 24, configuration/revision or
seed differs, the credential is absent, the observation lacks a non-empty
`accessibility_tree`, the model response violates the structured decision
schema, an action cannot be represented by `computer_13`, episode boundaries
are crossed, or the child process exits non-zero.

## Smoke / preflight

This checks the bridge/configuration contract without creating or resetting a
VM and without generating an episode or score:

```bash
python3 benchmarks/osworld/lhic_osworld_agent.py --preflight
```

A real single-domain smoke is owned by the official harness (after completing
its gated task/assets and provider setup):

```bash
python3 benchmarks/osworld/run_official.py \
  --osworld-root /absolute/path/to/OSWorld-V2 \
  --benchmark-revision osworld-v2-2026.06.24 \
  --provider_name docker \
  --action_space computer_13 \
  --observation_type screenshot_a11y_tree \
  --eval_version v2 \
  --domain libreoffice \
  --max_steps 15 \
  --model lhic-task-source \
  --result_dir /absolute/path/to/osworld-smoke-results
```

Use a domain/task selection available in the pinned gated release and configured
provider. The official harness writes evaluator outputs; the separate LHIC
JSONL at `resultPath` records protocol revision, seed, non-secret TaskSource
configuration, observation hashes, step receipts, terminal/error state, and no
score.

## Full official run

After the same pinned setup succeeds, omit `--domain` (the official default is
`all`) and use the release's intended step limit and result directory:

```bash
python3 benchmarks/osworld/run_official.py \
  --osworld-root /absolute/path/to/OSWorld-V2 \
  --benchmark-revision osworld-v2-2026.06.24 \
  --provider_name docker \
  --action_space computer_13 \
  --observation_type screenshot_a11y_tree \
  --eval_version v2 \
  --max_steps 50 \
  --model lhic-task-source \
  --result_dir /absolute/path/to/osworld-full-results
```

Do not treat preflight output, LHIC receipts, or a completed process as a
benchmark score. Only the pinned official evaluator result is a score.
