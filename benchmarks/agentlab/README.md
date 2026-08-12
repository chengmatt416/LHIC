# AgentLab runner

This digest-pinned Python 3.12/Debian bookworm image provides the complete
AgentLab experiment runtime needed for the supported BrowserGym studies:
AgentLab 0.4.0, BrowserGym/WebArena 0.14.3, WorkArena 0.5.3, NLTK's required
`punkt_tab` data, and image-owned Chromium. It has a credential-free `preflight`
target and a non-root `runner` target. The runner accepts only complete named
benchmarks; it intentionally has no task-filter option. Preflight imports both
LHIC adapters, constructs the `workarena_l1` study without running it, and
launches Chromium.

```bash
docker build --target preflight --tag lhic-agentlab-preflight:local benchmarks/agentlab
docker run --rm lhic-agentlab-preflight:local

docker build \
  --target runner \
  --build-arg LHIC_SOURCE_REVISION=<committed-lhic-sha> \
  --tag lhic-agentlab-runner:local \
  benchmarks/agentlab
```

## WebArena model-backed runner

The formal runner defaults to `--agent full`. It combines the safe semantic
fast path with a general model planner whose output must match a strict,
single-action JSON schema. The model output is rendered into one allowlisted
BrowserGym command and is never evaluated as Python. The next observation must
echo the exact command before the agent records a succeeded or failed action
receipt. Receipt IDs, action hashes, source (`semantic-fast-path` or
`model-planner`), model name, seed, and step appear in AgentLab's per-action
`AgentInfo` artifacts.

The transport uses the OpenAI-compatible chat-completions protocol but is not
tied to one hosted provider. Configure:

- `LHIC_MODEL`: endpoint model identifier (or pass `--model`);
- `LHIC_MODEL_BASE_URL`: endpoint root ending at `/v1` when applicable;
- `LHIC_MODEL_API_KEY_ENV`: name of the environment variable containing the
  endpoint credential (default `OPENAI_API_KEY`);
- the credential variable named by `LHIC_MODEL_API_KEY_ENV`;
- `WA_SHOPPING`, `WA_SHOPPING_ADMIN`, `WA_REDDIT`, `WA_GITLAB`,
  `WA_WIKIPEDIA`, `WA_MAP`, and `WA_HOMEPAGE` for the deployed WebArena
  instance; optionally `WA_FULL_RESET`.

WebArena's own fuzzy-match evaluator may separately require `OPENAI_API_KEY`,
even when the agent uses another compatible provider. Keep all credential
values in the runtime environment file. Without a model name or the configured
credential variable, `--agent full` exits non-zero before creating a study.

After building the runner and setting its immutable identity, this exact debug
smoke exercises the real full agent and model path for one step on every
published WebArena episode (it is not a comparable score):

```bash
export LHIC_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' lhic-agentlab-runner:local)"
docker run --rm \
  --env-file /secure/path/webarena.env \
  -e LHIC_IMAGE_DIGEST \
  -v /absolute/path/to/smoke-results:/results \
  lhic-agentlab-runner:local \
  --benchmark webarena \
  --agent full \
  --no-semantic-fast-path \
  --seed 0 \
  --jobs 1 \
  --backend sequential \
  --max-steps 1
```

Run the unmodified complete suite by omitting the debug limit:

```bash
docker run --rm \
  --env-file /secure/path/webarena.env \
  -e LHIC_IMAGE_DIGEST \
  -v /absolute/path/to/full-results:/results \
  lhic-agentlab-runner:local \
  --benchmark webarena \
  --agent full \
  --seed 0 \
  --jobs 1 \
  --backend sequential \
  --strict-reproducibility
```

The commands read `LHIC_MODEL`, `LHIC_MODEL_BASE_URL`, and
`LHIC_MODEL_API_KEY_ENV` inside the container from the environment file. Pass
their equivalent command-line flags only when intentionally overriding that
file.

## WorkArena full run

For a WorkArena L1 full run, record the immutable local image ID, use a
separately controlled environment file with approved gated access, mount an
empty results directory, and retain the exact command with the artifact:

```bash
export LHIC_IMAGE_DIGEST="$(docker image inspect --format '{{.Id}}' lhic-agentlab-runner:local)"

docker run --rm \
  --env-file /secure/path/workarena.env \
  -e LHIC_IMAGE_DIGEST \
  -v /absolute/path/to/results:/results \
  lhic-agentlab-runner:local \
  --benchmark workarena_l1 \
  --agent full \
  --seed 0 \
  --jobs 1 \
  --backend sequential \
  --strict-reproducibility
```

The runner writes `lhic-study-manifest.json` inside the AgentLab study
directory only after AgentLab has produced one non-error reward result for
every experiment in the named suite; incomplete and errored studies exit
non-zero without a manifest. It records the selected agent and non-secret model
configuration, fixed seed, all resolved Python distribution versions and their
inventory SHA-256, supplied LHIC source revision, immutable image ID, and
SHA-256 values for every regular study artifact. It records only the configured
credential environment-variable name, never its value. The runner rejects
symbolic-link artifacts and refuses to overwrite an existing manifest. The
same source revision is an OCI image label. Strict runs reject a missing source
revision or image digest.
Record the resolved image ID and this manifest with every experiment:

```bash
docker image inspect lhic-agentlab-runner:local --format '{{.Id}}'
```

For WorkArena, obtain gated instance access separately and pass credentials
only through the approved runtime secret mechanism. Never bake them into the
image, shell history, comment, trace, manifest, or evidence artifact.

## Semantic-only debug adapter

`--agent semantic` explicitly selects `LhicSemanticAgentArgs` from
`lhic_agent.py`. It is a credential-free, low-risk debug policy, not the formal
general agent. It translates explicit goals and BrowserGym `pruned_html` into
BID-bound interactions. It supports search, safe navigation, and selected form
steps, while rejecting ambiguous or side-effecting actions. It also requires
BrowserGym to echo the exact previous action and stops rather than assuming an
action executed.

Run the standard-library policy tests without AgentLab installed:

```bash
PYTHONPATH=benchmarks/agentlab python3 -m unittest discover -s benchmarks/agentlab/tests
```

Neither a successful container invocation nor a complete manifest is a
performance claim or an external submission. They prove only that the named
suite ran to completion with traceable configuration and artifacts.
