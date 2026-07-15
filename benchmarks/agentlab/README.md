# AgentLab runner

This pinned preflight image removes the host-Python version variable for adapter verification. It installs AgentLab 0.4.2's adapter API, BrowserGym Core and Experiments 0.14.3, and Chromium under Python 3.12 on Debian bookworm; it then imports AgentLab/BrowserGym, imports the LHIC adapter, and launches Chromium from the image-owned `/ms-playwright` path without reading any credential value. It includes only the BrowserGym experiment dependencies needed for this import path (`pandas` and `tqdm`), not AgentLab's full experiment runtime.

```bash
docker build --tag lhic-agentlab:local benchmarks/agentlab
docker run --rm lhic-agentlab:local
docker image inspect lhic-agentlab:local --format '{{index .RepoDigests 0}}'
```

Record the resolved image digest with every actual experiment. This image is only an adapter prerequisite. It contains the LHIC `AgentArgs` bridge, but not AgentLab's complete experiment stack, benchmark packages, benchmark configuration, an API key, a WorkArena access token, or a benchmark result. It cannot be used to make a performance claim or submit a leaderboard result.

For WorkArena, obtain gated instance access separately and pass credentials only through the approved runtime secret mechanism. Never bake them into the image or an evidence artifact.

## Initial semantic-BID adapter

`lhic_agent.py` exposes `LhicSemanticAgentArgs` to AgentLab. It translates an explicit, low-risk search goal and BrowserGym `pruned_html` into `fill(bid, value)` followed by `press(bid, 'ENTER')`; it can also issue one verified semantic field-fill action. It only acts on a matched control and reports every other or high-risk goal as infeasible.

Run the standard-library policy tests without AgentLab installed:

```bash
PYTHONPATH=benchmarks/agentlab python3 -m unittest discover -s benchmarks/agentlab/tests
```

This is a debug adapter, not a complete benchmark agent. It must gain task planning, post-action verification, state recovery, the full pinned AgentLab experiment stack, and full-suite evidence before any external submission.
