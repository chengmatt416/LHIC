# External benchmark protocol

The internal benchmark is a regression/smoke suite. Its score is **not** comparable to the web-agent market and must never be used in a SOTA claim.

The external gate uses BrowserGym/AgentLab-compatible benchmarks. Start with WorkArena for deterministic enterprise workflows and WebArena for broader multi-site tasks. Run the complete published suite, not a hand-picked subset, in a pinned container with a fixed benchmark commit and seed.

## Required evidence

1. Publish the unmodified benchmark commit, container digest, launch command, seed, and complete result artifact.
2. Record the current public comparator source and its observation date before running the candidate.
3. Supply the artifact to `lhic bench validate-evidence evidence.json`.
4. Arrange an independent reproduction. Local validation will deliberately never authorize a SOTA claim.

The evidence JSON fields are validated by the CLI. A result is reviewable only when it is a full-suite run, beats the recorded comparator, and includes immutable runner/artifact identifiers. A market SOTA statement additionally requires a public, independently reproduced result and product adoption evidence.

## Recommended progression

Begin with a single WorkArena L1 debug task through an AgentLab-compatible adapter, then run the unmodified complete L1 suite with fixed reproducibility settings. Do not use the local selector-resilience ablation as a public comparator or submission artifact; its fixed-selector treatment is intentionally narrow. The decision framework is in [market research and benchmark strategy](../docs/market-research.md).

Use `lhic bench readiness workarena` or `lhic bench readiness webarena` to identify missing local prerequisites. A passing readiness check only proves that the local runner can be configured; it does not authorise submission.

For a host-independent Python 3.12 AgentLab/Chromium runner, the default
schema-constrained model-backed agent, and the credential-free semantic debug
adapter, see [the AgentLab runner](agentlab/README.md). The runner can execute a
complete named AgentLab suite and produces a file-hashed study manifest, but it
does not provide a configured benchmark instance, a public result, or evidence
of competitive performance.

## Release bar

- WorkArena: full published suite, fixed seed, verifier-backed action traces.
- WebArena: full published suite, fixed seed, no hidden task-specific selectors.
- Production: all CI gates pass, `LHIC_ENV=production` has an HTTPS origin allowlist, and high-risk actions have human approvals.

## What “submission” means

A completed local run is only a candidate evidence artifact. It becomes an
external submission only through the benchmark owner's current process, after
an authorised human has reviewed the complete trajectories, configuration, and
manifest. None of the commands in this repository uploads results, opens a pull
request, or updates a leaderboard.
After human review, WebArena or OSWorld candidate evidence can be checked
locally with `npm run bench:evidence:validate -- /path/to/evidence.json`. This
validates metadata only and deliberately cannot authorise or perform a
submission. τ³-bench uses its own upstream `tau2 submit validate` schema.

### WebArena

- **Official path:** the [canonical WebArena repository](https://github.com/web-arena-x/webarena)
  links its public
  [leaderboard](https://docs.google.com/spreadsheets/d/1M801lEpBbKSNwP-vDBkC_pF7LdyGU1f_ufZb_NWNBZQ/edit?usp=sharing).
  It documents the 812-task evaluation but no self-service submission command
  or result-upload API. AgentLab's
  [unified leaderboard](https://huggingface.co/spaces/ServiceNow/browsergym-leaderboard)
  currently marks WebArena reporting as forthcoming. Do not infer an upload
  workflow: retain the full study and ask the current benchmark maintainers for
  review only after human authorisation.
- **Project path:** first run `npm run bench:webarena:readiness`, then the
  credential-free container preflight in
  [the AgentLab runner guide](agentlab/README.md). A full authorised run uses
  the same runner with `--benchmark webarena --agent full --model
<pinned-model-id> --seed 0 --jobs 1 --backend sequential
--strict-reproducibility`. It writes
  `lhic-study-manifest.json` only after every expected experiment has a
  non-error reward result; this is evidence preparation, not submission.
- **External conditions:** a pinned, self-hosted WebArena instance and the
  BrowserGym URL variables `WA_SHOPPING`, `WA_SHOPPING_ADMIN`, `WA_REDDIT`,
  `WA_GITLAB`, `WA_WIKIPEDIA`, `WA_MAP`, and `WA_HOMEPAGE` (optionally
  `WA_FULL_RESET`). The model-backed project agent accepts `LHIC_MODEL`,
  `LHIC_MODEL_BASE_URL`, and `LHIC_MODEL_API_KEY_ENV`; the last names the
  credential variable (default `OPENAI_API_KEY`) without reading it into the
  manifest. The official evaluator also needs `OPENAI_API_KEY` for fuzzy-match
  evaluations. Pass values through an approved runtime environment file; never
  record their values.
- **Safe next step:** `npm run bench:webarena:readiness` and the AgentLab
  `preflight` image are read-only readiness checks. Stop before a paid model
  run or any maintainer contact unless a human authorises it.

### OSWorld 2.0

- **Official path:** use the supported
  [`xlang-ai/OSWorld-V2`](https://github.com/xlang-ai/OSWorld-V2) release and
  follow its
  [Public Evaluation instructions](https://github.com/xlang-ai/OSWorld-V2#public-evaluation).
  Verified leaderboard publication is not a file upload: the maintainers
  require a scheduled run on their side, disclosure of the OSWorld-framework
  agent implementation plus an explanatory report (the model API may remain
  private), or monitoring data and trajectories from a trusted institution.
- **Project path:** `benchmarks/osworld/lhic_osworld_agent.py` is the drop-in
  `computer_13`/accessibility-tree adapter for the official harness. It owns no
  VM lifecycle or evaluator. It exchanges strict JSONL episode messages with
  `lhic_osworld_bridge.ts`, which records the benchmark revision, seed,
  non-secret TaskSource/harness configuration, action receipts, and terminal
  state without recording credential values. `run_official.py` loads the
  adapter into the pinned upstream harness; its exact smoke/full commands are
  in [the bridge guide](osworld/README.md). Run
  `npm run bench:osworld:bridge:preflight` before integrating the adapter.
- **External conditions:** pin the supported release manifest
  `osworld-v2-2026.06.24`, including code tag `v2026.06.24`, gated task classes
  and assets at the matching revision, and the matching mocked websites.
  OSWorld 2.0 currently supplies Docker and AWS images; Docker needs KVM.
  Required names vary by provider/tasks and can include
  `OSWORLD_FILE_BASE_URL`, `WEBSITE_HOST_SUFFIX`, `GITLAB_URL`,
  `GITLAB_PRIVATE_TOKEN`, `OSWORLD_CLIENT_PASSWORD`, AWS variables, and the
  model key named by `OSWORLD_EVAL_MODEL_API_KEY_ENV`. The LHIC adapter uses
  `LHIC_OSWORLD_BRIDGE_CONFIG`, `LHIC_OSWORLD_BRIDGE_COMMAND_JSON`,
  `LHIC_OSWORLD_BENCHMARK_REVISION`, and `LHIC_OSWORLD_SEED` (the latter two
  may instead be constructor arguments). Public evaluation additionally
  requires
  maintainer scheduling and human approval for disclosure.
- **Safe next step:** under Node 24, run
  `npm run bench:osworld:bridge:preflight`; it validates the local config and
  TaskSource without creating a VM or running an episode. Then provision the
  pinned upstream release and gated assets. Do not run a benchmark or contact
  maintainers without human approval.

### τ³-bench

- **Official path:** the current τ³-bench implementation remains the
  [`sierra-research/tau2-bench`](https://github.com/sierra-research/tau2-bench)
  repository and `tau2` Python package. Follow its
  [leaderboard submission guide](https://github.com/sierra-research/tau2-bench/blob/main/docs/leaderboard-submission.md):
  run the unfiltered `base` task split with consistent model arguments
  (preferably at least four trials per domain), use `tau2 submit prepare`, then
  `tau2 submit validate`, commit only `submission.json` plus the upstream
  leaderboard manifest change in a fork, and open a pull request with a
  separately hosted trajectory link. This repository never performs the fork,
  upload, commit, or pull request.
  Because LHIC changes the standard scaffold, any eventual entry must declare
  `submission_type` as `custom`, document the methodology, and link the
  implementation as required by the upstream guide.
- **Project path:** `benchmarks/tau/run_tau3.py` pins upstream v1.0.1 commit
  `fc0055dc4e0a316c3f83133267fbd6faaa770992`, registers
  `--agent lhic_policy_tool`, and delegates only `run` to the upstream `tau2`
  CLI. It must be launched from that exact checkout with Python 3.12–3.13 and
  `uv`. Non-help runs require explicit `--domain`, `--agent-llm`,
  `--num-trials`, and `--seed`, reject another agent or voice mode, and exit
  non-zero for infrastructure/error terminations or missing rewards. Upstream
  `results.json` records the upstream revision, trial count, domain, seed, and
  model arguments; retain the exact LHIC revision alongside it before using
  `tau2 submit prepare`.
- **External conditions:** a pinned τ³-bench release (banking results from
  versions before 1.0.1 are not comparable with 1.0.1 or later), `uv`, a
  supported Python, and the selected model/user-simulator provider credentials.
  The upstream environment names include `OPENAI_API_KEY`,
  `ANTHROPIC_API_KEY`, and `OPENROUTER_API_KEY` as applicable. Voice evaluation
  additionally needs `ELEVENLABS_API_KEY`, `DEEPGRAM_API_KEY`, provisioned
  `TAU2_VOICE_ID_*` names, and maintainer coordination; the current LHIC agent
  is text half-duplex only.
- **Safe next step:** in the pinned upstream checkout run
  `uv run python /absolute/path/to/LHIC/benchmarks/tau/run_tau3.py run --help`.
  This verifies the pinned package/revision plus CLI registration without
  making a model request. A paid run and `tau2 submit prepare` require human
  authorisation and complete, unfiltered domain results.
