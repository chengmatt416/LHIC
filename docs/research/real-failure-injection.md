# Real Browser / Desktop / Code Failure-Injection Experiments

This suite upgrades the synthetic failure harness into integration experiments against **real external execution surfaces** while keeping the LHIC-Core execution semantics fixed.

The goal is not to claim an official OSWorld, SWE-bench, or τ-bench result. The goal is to test one systems invariant under an externally committed side effect:

> If the side effect has already happened but the dispatcher dies before the agent receives completion, recovery must re-observe and verify the external world before any replay.

## Failure injected

All three surfaces use the same failure window:

```text
persist possibly_committed
        |
        v
dispatch real external action
        |
        v
external side effect commits
        |
        X  dispatcher process is SIGKILLed
        |
        v
agent receives no success response
```

The blind-retry baseline executes the same logical action a second time after the missing response. LHIC-Core instead reconstructs a fresh ledger/kernel instance, observes the external state, verifies the postcondition, and must reach `verified` without a second dispatch.

## Browser experiment

`experiments/real/browser.ts`

- Starts a real local HTTP fixture.
- Launches real Chromium through Playwright.
- A worker submits a real HTML form that increments a server-side committed order counter.
- After navigation confirms the commit, the worker process is killed before it can report agent completion.
- The blind-retry baseline submits the form twice.
- LHIC-Core reloads the durable ledger, opens Chromium again, observes the DOM, and hashes a screenshot as verifier evidence.

## Desktop experiment

`experiments/real/desktop.ts` + `desktop-fixture.py`

- Runs an actual Tk desktop window inside Xvfb.
- Uses `xdotool` to move an X11 pointer to a deterministically positioned native button and issue a real mouse click.
- The Tk application persists the committed counter and updates the native X11 window title.
- The worker is killed only after the visible counter increases, proving that the GUI side effect was processed before the crash.
- Recovery observes the window title with `xdotool getwindowname` and verifies it against persisted fixture state.

This is intentionally a small deterministic GUI fixture. The research object is crash/recovery semantics, not visual grounding quality.

## Code experiment

`experiments/real/code.ts`

- Creates a real isolated Git repository.
- A worker edits `feature.txt`, stages it, and creates a real Git commit.
- The worker is killed immediately after `git commit`.
- The blind-retry baseline repeats the edit/commit and creates a duplicate marker and second commit.
- LHIC-Core reloads its durable ledger, observes the repository, verifies file content plus Git history, and does not create a second commit.

## Hard acceptance gate

`experiments/real/run-all.ts` does not consider a zero-exit experiment sufficient. The full suite fails unless **every trial** satisfies all of the following:

Baseline:

```text
sideEffects              = 2
duplicateSideEffects     = 1
```

LHIC-Core:

```text
sideEffects              = 1
duplicateSideEffects     = 0
firstState               = possibly_committed
recoveredState           = verified
dispatches               = 1
observations             = 1
verifications            = 1
```

This gate was added after an early desktop fixture run exposed a false-green condition: an input worker could exit abnormally before producing a GUI effect. The final experiment therefore requires proof that the baseline actually duplicated a committed effect and that LHIC actually recovered it.

## Validated result

Current results commit:

```text
4ba7e227936d3be6c670a72ba88655f1929c8b7b
```

GitHub Actions `Real Failure Injection` run:

```text
31878534758
```

Environment:

```text
Ubuntu 24.04
Linux x64
Node.js v22.23.2
10 trials per surface
30 trials total
```

Measured result:

| Surface | Trials | Baseline duplicate effects | LHIC duplicate effects | Verified recovery |
|---|---:|---:|---:|---:|
| Browser / Chromium | 10 | 10 | 0 | 10 / 10 |
| Desktop / X11 + Tk | 10 | 10 | 0 | 10 / 10 |
| Code / Git | 10 | 10 | 0 | 10 / 10 |
| **Total** | **30** | **30** | **0** | **30 / 30** |

The workflow uploads the complete machine-readable evidence as:

```text
artifacts/real-failure-injection-results.json
```

with schema `lhic-real-failure-injection-suite-v1`.

## Metrics

Each surface emits `LHIC_REAL_RESULT=<json>` with:

- committed side-effect count;
- duplicate side-effect count;
- first ledger state;
- recovered ledger state;
- dispatcher count;
- observation count;
- verifier count;
- recovery success count.

## Reproduction

Code-only experiment needs Node and Git:

```bash
LHIC_REAL_TRIALS=10 npm run experiment:code
```

Browser experiment:

```bash
npm install --no-save --ignore-scripts playwright@1.62.1
npx playwright install --with-deps chromium
LHIC_REAL_TRIALS=10 npm run experiment:browser
```

Desktop experiment on Debian/Ubuntu:

```bash
sudo apt-get install xvfb xauth xdotool python3-tk
LHIC_REAL_TRIALS=10 npm run experiment:desktop
```

Full suite:

```bash
LHIC_REAL_TRIALS=10 npm run experiment:real
```

The GitHub workflow `.github/workflows/real-failure-injection.yml` pins Playwright and runs the full suite on Ubuntu 24.04.

## Claim boundary

These experiments provide **real-surface internal-validity evidence** for the side-effect recovery protocol. They use real Chromium, real X11 GUI events, and real Git commits, but the tasks remain controlled fixtures designed to isolate one failure window.

Therefore the result does not establish general agent capability, real-web robustness, OSWorld performance, SWE-bench performance, τ-bench performance, or universal safety. The next external-validity layer should reuse the same fault injector around real benchmark adapters while preserving official benchmark scoring.
