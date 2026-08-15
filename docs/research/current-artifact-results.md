# Current Artifact Results

These results are **artifact-validation and controlled integration results**, not external benchmark claims.

## Validated implementation

- Branch: `research/lhic-core-academic`
- Current artifact commit: `3916eeb8b5c88ed362e8863ef7ac8b30b5d9e959`
- GitHub Actions workflow: `Real Failure Injection`
- Validated run: `31879445101`
- Evidence artifact: `9245643081`
- Evidence artifact digest: `sha256:82e1c7982d21ef1299c63eaf1034f1c2141b041c4291d488d77c068fdca70b32`
- Environment: Ubuntu 24.04 / Linux x64 / Node.js v22.23.2
- Real-surface trials: 10 per surface, 30 total
- Expanded semantic matrix: 5 failure-mode cases

The workflow contains a hard acceptance gate: it fails unless every real-surface trial demonstrates a duplicate in the blind-retry baseline and reaches `verified` with exactly one LHIC dispatch, one recovery observation, one verification, and zero duplicate side effects. The expanded matrix fails unless each semantic variant matches the expected non-replay state and produces zero duplicate side effects.

## Core invariant and kernel tests

The academic artifact currently has thirteen tests:

1. planner cannot lower independently inferred risk;
2. high-risk action cannot use reusable origin scope;
3. verification requires independent non-empty evidence;
4. ambiguous side effect is not blindly retried;
5. verified action identity cannot be dispatched again;
6. trusted skill promotion requires three independent verified task IDs;
7. lost response after an external effect is recovered without a second dispatch;
8. verified action identity remains terminal across later runs;
9. pre-dispatch ambiguity with absent effect does not auto-dispatch;
10. delayed visibility can verify later without duplicate dispatch;
11. repeated inconclusive observations remain `needs_resolution` and non-dispatchable;
12. duplicate action delivery after verification is blocked without a second dispatch;
13. workspace conflict during recovery prevents verified completion without replay.

The current artifact commit passed the normal `Academic Artifact` workflow and the real-surface workflow.

## Controlled real-surface failure injection

Injected failure for every surface:

```text
persist possibly_committed
        -> dispatch real external action
        -> external effect commits
        -> dispatcher process is SIGKILLed
        -> agent receives no completion response
        -> restart from durable ledger
        -> observe external state
        -> verify postcondition
        -> do not replay
```

### Current 30-trial results

| Surface | Trials | Blind-retry baseline duplicate effects | LHIC-Core duplicate effects | LHIC recovery success |
|---|---:|---:|---:|---:|
| Browser / Chromium | 10 | 10 | 0 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 | 0 | 10 / 10 |
| Code / Git | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Every LHIC-Core trial had the same state/evidence pattern:

```text
firstState       = possibly_committed
recoveredState   = verified
dispatches       = 1
observations     = 1
verifications    = 1
sideEffects      = 1
duplicateEffects = 0
```

Every blind-retry baseline trial produced two committed effects for the same logical action, i.e. one duplicate effect per trial.

## Fresh-run repeatability check

Before the expanded matrix was added, the exact same 30-trial real-surface workflow was re-run on commit `4ba7e227936d3be6c670a72ba88655f1929c8b7b`.

Attempt 2 reproduced the same aggregate outcome:

| Surface | Trials | Blind-retry duplicate effects | LHIC-Core duplicate effects | Verified recovery |
|---|---:|---:|---:|---:|
| Browser / Chromium | 10 | 10 | 0 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 | 0 | 10 / 10 |
| Code / Git | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Across the primary run and the rerun, this gives **60 controlled real-surface trial executions** with the same qualitative outcome: 60 baseline duplicate effects, 0 LHIC duplicate effects, and 60 verified LHIC recoveries. The current commit keeps the same 30-trial real-surface result and adds the expanded matrix below.

## Expanded failure matrix

The expanded matrix varies adjacent ambiguity semantics beyond the flagship post-commit / pre-response crash window.

| Case | Expected final state | Observed state | Durable ledger state | Dispatches | Observations | Verifications | Side effects | Duplicate effects | Result |
|---|---|---|---|---:|---:|---:|---:|---:|---|
| Pre-dispatch crash | `needs_resolution` | `needs_resolution` | `needs_resolution` | 1 | 1 | 0 | 0 | 0 | PASS |
| Delayed visibility | `verified` | `verified` | `verified` | 1 | 2 | 1 | 1 | 0 | PASS |
| Inconclusive observation | `needs_resolution` | `needs_resolution` | `needs_resolution` | 1 | 1 | 0 | 1 | 0 | PASS |
| Duplicate delivery | `executed` receipt / `verified` ledger | `executed` | `verified` | 1 | 0 | 1 | 1 | 0 | PASS |
| Workspace conflict | `executed` | `executed` | `executed` | 1 | 1 | 1 | 1 | 0 | PASS |

The five matrix cases completed in 65 ms total in the CI artifact. The latency value is a harness sanity measurement, not an optimized performance result.

## Surface details

### Browser

The browser experiment uses a real local HTTP server and real Chromium through Playwright. The worker submits an HTML form that increments a server-side committed counter, then is killed after navigation confirms the commit. Recovery starts a fresh Chromium observation, reads the DOM, and hashes a screenshot as verifier evidence.

### Desktop

The desktop experiment runs a real Tk window inside Xvfb and uses `xdotool` to deliver a real X11 mouse click to a deterministically positioned button. The Tk application persists the committed counter and exposes it in the native window title. The worker is killed only after the visible counter increases. Recovery observes the X11 window title and verifies it against persisted fixture state.

### Code

The code experiment creates a real isolated Git repository. The worker appends a marker, stages it, creates a real Git commit, and is killed immediately after commit. Recovery inspects both file content and Git history. Blind retry creates a duplicated marker/commit; LHIC-Core does not.

## Deterministic synthetic failure injection

The synthetic harness remains useful as a fast semantic regression suite. It runs 100 deterministic trials per strategy over five modeled failure modes.

| Strategy | Task success | Duplicate side effects / trial | False success | Human resolution |
|---|---:|---:|---:|---:|
| Vanilla | 1.00 | 0.60 | 0.00 | 0.00 |
| Verifier only | 1.00 | 0.40 | 0.00 | 0.00 |
| Ledger only | 0.80 | 0.00 | 0.00 | 0.80 |
| Full LHIC-Core | 0.80 | 0.00 | 0.00 | 0.20 |

The synthetic results are not substituted for the real-surface experiments; they serve different purposes. The simulator gives fast coverage of semantic branches, while the browser/desktop/code suite verifies that the protocol survives real process boundaries and real external state changes.

## Interpretation and claim boundary

The controlled real-surface result supports a narrow claim:

> Under the injected post-commit / pre-response crash window, LHIC-Core's durable `possibly_committed` state plus observe-and-verify recovery prevented duplicate replay in all 30 current controlled browser, desktop, and code trials, reproduced the same outcome in an earlier independent 30-trial workflow attempt, and passed five adjacent ambiguity cases in the expanded matrix, while the blind-retry baseline duplicated the effect in every flagship real-surface trial.

This does **not** establish general computer-use capability, statistical superiority in open-world tasks, or SOTA performance on OSWorld, SWE-bench, tau-bench, or other official benchmarks. The fixtures are deliberately controlled to isolate execution semantics.

## Next evaluation layer

The next publication-facing experiments should add:

1. multiple randomized visibility delays rather than a single delayed-visibility case;
2. partial commit cases where verifier evidence is mixed;
3. larger same-repo concurrent workspace mutations;
4. latency / added-observation / verifier overhead across repeated runs;
5. official benchmark adapters that preserve evaluator scoring rules.
