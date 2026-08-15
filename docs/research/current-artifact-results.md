# Current Artifact Results

These results are **artifact-validation and controlled integration results**, not external benchmark claims.

## Validated implementation

- Branch: `research/lhic-core-academic`
- Real-surface implementation commit: `d145970295e645d7790647cb237ed20eff6172c2`
- GitHub Actions workflow: `Real Failure Injection`
- Validated run: `31878130504`
- Environment: Ubuntu 24.04 / Linux x64 / Node.js v22.23.2
- Real trials: 3 per surface, 9 total

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

The exact implementation commit above passed the normal `Academic Artifact` workflow as well as the real-surface workflow.

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

### Results

| Surface | Trials | Blind-retry baseline duplicate effects | LHIC-Core duplicate effects | LHIC recovery success |
|---|---:|---:|---:|---:|
| Browser / Chromium | 3 | 3 | 0 | 3 / 3 |
| Desktop / X11 + Tk | 3 | 3 | 0 | 3 / 3 |
| Code / Git | 3 | 3 | 0 | 3 / 3 |
| **Total** | **9** | **9** | **0** | **9 / 9** |

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

> Under the injected post-commit / pre-response crash window, LHIC-Core's durable `possibly_committed` state plus observe-and-verify recovery prevented duplicate replay in all 9 controlled browser, desktop, and code trials, while the blind-retry baseline duplicated the effect in all 9 trials.

This does **not** establish general computer-use capability, statistical superiority in open-world tasks, or SOTA performance on OSWorld, SWE-bench, τ-bench, or other official benchmarks. The fixtures are deliberately controlled to isolate execution semantics.

The next evaluation layer should increase trial counts, inject multiple failure timings and visibility delays, report confidence intervals and overhead, and then reuse the same fault-injection mechanism around official benchmark adapters without changing their scoring rules.
