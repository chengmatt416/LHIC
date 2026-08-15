# Current Artifact Results

These results are **artifact-validation and controlled integration results**, not external benchmark claims.

## Validated implementation

- Branch: `research/lhic-core-academic`
- Real-surface experiment commit: `4ba7e227936d3be6c670a72ba88655f1929c8b7b`
- GitHub Actions workflow: `Real Failure Injection`
- Workflow run: `31878534758`
- Attempt 1 artifact: `9245405184`
- Attempt 2 artifact: `9245462560`
- Environment: Ubuntu 24.04 / Linux x64 / Node.js v22.23.2
- Trials per attempt: 10 per surface, 30 total
- Combined real-surface trial executions across two workflow attempts: 60

The real workflow contains a hard acceptance gate: it fails unless every trial demonstrates a duplicate in the blind-retry baseline and reaches `verified` with exactly one LHIC dispatch, one recovery observation, one verification, and zero duplicate side effects.

## Core invariant and kernel tests

The academic artifact currently has eight tests:

1. planner cannot lower independently inferred risk;
2. high-risk action cannot use reusable origin scope;
3. verification requires independent non-empty evidence;
4. ambiguous side effect is not blindly retried;
5. verified action identity cannot be dispatched again;
6. trusted skill promotion requires three independent verified task IDs;
7. lost response after an external effect is recovered without a second dispatch;
8. verified action identity remains terminal across later runs.

The 30-trial experiment commit passed the normal `Academic Artifact` workflow as well as the real-surface workflow.

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

### Primary 30-trial results

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

The exact same implementation commit and 30-trial workflow were re-run in a fresh GitHub Actions attempt.

Attempt 2 reproduced the same aggregate outcome:

| Surface | Trials | Blind-retry duplicate effects | LHIC-Core duplicate effects | Verified recovery |
|---|---:|---:|---:|---:|
| Browser / Chromium | 10 | 10 | 0 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 | 0 | 10 / 10 |
| Code / Git | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

Across the two workflow attempts, this gives **60 controlled real-surface trial executions** with the same qualitative outcome: 60 baseline duplicate effects, 0 LHIC duplicate effects, and 60 verified LHIC recoveries.

This repeatability check is useful evidence that the primary result is not a one-off runner artifact. It is still not a new task distribution or an external benchmark sample; both attempts use the same controlled fixtures and failure semantics.

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

> Under the injected post-commit / pre-response crash window, LHIC-Core's durable `possibly_committed` state plus observe-and-verify recovery prevented duplicate replay in all 30 primary controlled browser, desktop, and code trials and reproduced the same outcome in a second 30-trial workflow attempt, while the blind-retry baseline duplicated the effect in every trial.

This does **not** establish general computer-use capability, statistical superiority in open-world tasks, or SOTA performance on OSWorld, SWE-bench, tau-bench, or other official benchmarks. The fixtures are deliberately controlled to isolate execution semantics.

## Next evaluation layer

The next publication-facing experiments should vary the failure window rather than only repeat the flagship case:

1. crash after durable ambiguity persistence but before physical dispatch;
2. crash after effect commit but before response (current flagship);
3. delayed postcondition visibility after commit;
4. inconclusive observation that must remain `needs_resolution`;
5. duplicate/delayed executor response;
6. stale workspace mutation during recovery;
7. policy understatement and approval replay negative controls;
8. latency / extra-observation / verifier overhead.

After those controlled variants, the same fault injector should wrap official benchmark adapters while preserving their scoring rules.