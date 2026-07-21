# Build Week Demo Director

The Desktop app includes a fullscreen, keyboard-driven Demo Director for the
four-slide Build Week presentation. It coordinates the presentation while
keeping the project boundaries observable:

- Codex may initiate the Slow Path through LHIC MCP.
- LHIC owns browser actions, approvals, traces, and verifier evidence.
- A Fast Path starts inside LHIC and makes no LLM or MCP call.
- Financial/signature actions remain human handoffs.
- A Slow Path result is only a candidate after one run. Fast Path promotion
  still requires three distinct verifier-backed task IDs and an unseen-UI
  holdout.

## Start

```bash
npm run demo:director --workspace @lhic/desktop
```

The command builds the Desktop app, opens it fullscreen on slide 1, and enables
the `Space`-key stage transitions. Recording starts automatically while slide 1
remains visible; the first Space press shows slide 2. The demo defaults to the
test-only `LHICTEST`, `LHICMANAGER`, `LHICTEST2`, and `LHICMANAGER2`
identities. Optional `LHIC_DEMO_SLOW_EMPLOYEE`, `LHIC_DEMO_SLOW_MANAGER`,
`LHIC_DEMO_FAST_EMPLOYEE`, and `LHIC_DEMO_FAST_MANAGER` launch overrides stay
in process memory and are not rendered in the UI or evidence feed.
The finished timestamped `.mov` recording is saved directly in the current
macOS user's `Downloads` folder.

The presenter controls remain available during the session. **Save clip**
finalizes the current `.mov` in Downloads and immediately starts a new segment,
so an important section can be retained without ending the presentation. The
**Jump** selector moves directly to a presentation checkpoint while recording
continues. Jumping changes only the presentation view; it does not cancel an
active browser, Codex, or game process.

The Codex CLI model can be overridden without changing code:

```bash
LHIC_DEMO_CODEX_MODEL='gpt-5.6-luna'
```

Before the live presentation:

1. Grant the built Desktop app macOS Accessibility and Screen Recording
   permissions.
2. Confirm the Codex CLI is signed in. The demo launches GPT-5.6 Luna with
   medium reasoning in a focused, desktop-sized Terminal window and does not
   control the ChatGPT composer. It deliberately passes
   `--dangerously-bypass-approvals-and-sandbox`; use only the isolated test
   workspace and sandbox identities documented here.
3. Confirm Codex reports the LHIC MCP server as connected. Signed Plan repairs
   the local registration before launching the CLI when necessary.
4. Prepare a verifier-approved Challenge 2026 policy artifact at the configured
   local 3D demo path.

Employee identifiers are read from the launch environment into main-process
memory. They are not written to Demo Director configuration or evidence output.
Use test-only identities.

## Stage controls

| Stage           | `Space` result                                                     |
| --------------- | ------------------------------------------------------------------ |
| Slide 1         | Show slide 2; recording is already running                         |
| Slide 2         | Show live MCP connection proof                                     |
| MCP proof       | Open the signed Codex-dispatch approval screen                     |
| Signed plan     | Launch Codex CLI with Luna medium and focus its Terminal frame     |
| Slow execution  | Codex prompts are bypassed; LHIC action-policy gates remain active |
| Slow completion | Press Space again after the task finishes to show learning         |
| Learning        | Advances only when the local candidate is genuinely promoted       |
| Fast ready      | Starts model-free LHIC and focuses its Terminal evidence monitor   |
| Fast permission | Approves the currently pending LHIC action                         |
| Comparison      | Show slide 3                                                       |
| Slide 3         | Launch Challenge 2026 and the configured Game Lab policy           |
| Game            | Return to slide 4 automatically when playback finishes             |
| Slide 4         | Stop recording                                                     |

The game owns keyboard focus while it runs. Demo Director returns to slide 4
automatically when the Game Lab playback job completes, avoiding a global
`Space` hook that could interfere with game input.

Fast Path admission fails closed. If no promoted vendor Skill matches, LHIC
does not select a configured Slow Path provider and does not open the Terminal
monitor. When a local plan is admitted, the monitor filters the task journal by
that exact command ID so stale provider events cannot appear in the Fast Path
frame.

## Evidence shown to judges

The security panel reports real action-bound Ed25519 signing, certificate
fingerprint validation, active-window/process verification, task status, and
verifier evidence. Timer bars are computed from observed start/completion
boundaries; the application does not inject benchmark numbers. During Slow and
Fast execution, a click-through always-on-top timer remains visible over
Terminal and browser windows without taking keyboard focus.

At a checkout or other high-risk action, the LHIC MCP tool call stays pending
and opens a native **LHIC Human Permission** dialog. Codex CLI does not receive a
completed tool result while that dialog is open. Approve resumes the exact
action-bound step; Deny returns a terminal tool error. The demo MCP registration
uses a 15-minute tool timeout so an operator pause does not end the CLI run.

If promotion gates are not complete, the Fast Path control remains locked. This
is deliberate: prebuilding or instantly promoting the vendor Skill would make
the demonstration contradict LHIC's security model.
