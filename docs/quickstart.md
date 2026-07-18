# LHIC quick start

This guide starts a local runtime, verifies its browser capability, and connects
the MCP server to an agent client. It does not send page data, credentials, or
Fast Path actions to an LLM.

## 1. Install and verify

Use Node 24 and run the following from the repository root:

```bash
npm ci
npm run pw:install
npm start
npm run preflight
```

`npm start` creates `.lhic/skills.sqlite` and preloads the five built-in skills.
The MCP server creates the same local database automatically when it is its
first entrypoint, so a fresh checkout does not need a separate bootstrap step.

## 2. Connect an MCP client

Build and print a Codex configuration entry:

```bash
npm run mcp:config
```

Copy the emitted TOML into the reviewed MCP configuration, restart the client,
and confirm the server is connected. For Claude Code, VS Code, and Antigravity,
run `node apps/cli/dist/main.js mcp config <harness> .`; the supported harnesses
are listed in [MCP harness integrations](mcp-harnesses.md).

The server runs a visible browser by default. Use
`LHIC_MCP_HEADLESS=true` only for an unattended local workflow. Set
`LHIC_MEMORY_DATABASE=/absolute/path/skills.sqlite` to put the local skill and
selector memory somewhere other than `.lhic/skills.sqlite`.

## 3. Run a safe browser workflow

Ask the client to follow this sequence:

1. `lhic_runtime_status` confirms the browser and local memory state.
2. `lhic_browser_start` starts one local browser session.
3. `lhic_browser_observe` reads the normalized DOM/accessibility state.
4. `lhic_browser_act` sends one low-risk semantic action.
5. Check the returned verifier evidence and state, then call
   `lhic_browser_close` when done.

`lhic_skills_list` exposes only redacted skill summaries: name, lifecycle, and
success/failure counts. `lhic_selector_memory_list` exposes the same redacted
usage metadata for direct-DOM selector candidates, but never the selector
itself. A skill advances only after verified execution evidence; MCP callers
cannot mark a skill learned by assertion alone. High- and unknown-risk actions
still require a matching human approval.

## 4. Train a public website Fast Path

The first reproducible live-training scenarios cover public Wikipedia and MDN
search, GitHub issue filtering, and OpenStreetMap place lookup. They use a
fresh Playwright context, do not sign in, and submit only the non-sensitive
query supplied on the command line. Every action has a post-action verifier;
the learned action values and trace inputs are redacted.

```bash
lhic train public-web wikipedia-search --query "human computer interaction"
lhic train public-web mdn-search --query "CSS grid"
lhic train public-web github-issue-filter --query "is:issue state:open label:bug"
lhic train public-web openstreetmap-place-search --query "Taipei Main Station"
```

Use `--viewable` to watch the isolated browser and `--database <path>` to keep
the resulting local skill memory outside `.lhic/skills.sqlite`. If shared
skills are enabled first, a fully verified scenario is immediately queued for
Appwrite review; it remains unavailable to other clients until an approver
changes its status to `approved`.

## 5. Enable public shared skills (optional)

Deploy the Appwrite Function and create the TablesDB tables described in
[`services/appwrite-shared-skills`](../services/appwrite-shared-skills). Then
run the guided setup in a terminal:

```bash
lhic shared enable
```

Or provide the values explicitly for scripts and CI:

```bash
lhic shared enable \
  --endpoint https://<region>.cloud.appwrite.io/v1 \
  --project <project-id> \
  --function-url https://<function-domain> \
  --email you@example.com
```

After completing the Magic URL sign-in, LHIC caches approved public skills
locally, submits newly verified Slow Path skills for review, and refreshes its
cache at most once per 24 hours during runtime startup. The session is stored
in the operating-system credential store, not in `.lhic`. Use
`lhic_shared_skills_list` to inspect redacted cached summaries through MCP.

## What “speed”, “cost”, and “learning” mean

- **Speed:** known low-risk Fast Path workflows run locally through Playwright;
  they do not wait for an LLM round trip.
- **Cost:** Fast Path uses zero LLM calls, so its LLM-token cost per action is
  zero. This is not a claim that browser infrastructure or slow-path model use
  is free.
- **Learning:** successful direct DOM actions retain selector candidates in
  local SQLite. A verifier-backed Slow Path plan becomes a redacted candidate;
  it requires three independent task runs and a deterministic offline holdout
  before Fast Path promotion. Shared skill submissions occur only after that
  promotion, remain pending until approved in Appwrite, and never require a
  Fast Path network request.

Run `npm run bench:internal` and `npm run bench:simulate` to produce the local,
controlled measurements used in product demonstrations. They are not external
benchmark or market-comparison claims.
