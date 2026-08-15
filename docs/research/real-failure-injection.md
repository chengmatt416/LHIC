# Real Browser / Desktop / Code Failure-Injection Experiments

This suite upgrades the synthetic failure harness into integration experiments against **real external execution surfaces** while keeping the planner and LHIC-Core semantics fixed.

The goal is not to claim an official OSWorld, SWE-bench, or τ-bench result. The goal is to test one core systems invariant under an externally committed side effect:

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

A vanilla baseline treats the missing response as failure and executes the action a second time.

LHIC-Core reconstructs a fresh ledger/kernel instance, observes the external state, verifies the postcondition, and should reach `verified` without a second dispatch.

## Browser experiment

`experiments/real/browser.ts`

- Starts a real local HTTP fixture.
- Launches real Chromium through Playwright.
- A worker submits a real HTML form that increments a committed order counter.
- After the navigation confirms the commit, the dispatcher process is killed before it can report agent completion.
- The baseline executes the form submission twice.
- LHIC-Core reloads the durable ledger, opens Chromium again, observes the DOM, takes a screenshot as verifier evidence, and does not replay when exactly one committed order exists.

This experiment tests browser side effects, process failure, durable restart state, DOM re-observation, and screenshot-backed verification.

## Desktop experiment

`experiments/real/desktop.ts` + `desktop-fixture.py`

- Runs an actual Tk desktop window inside Xvfb.
- Uses `xdotool` to inject an OS-level `Ctrl+Enter` action into the window.
- The Tk application persists the committed counter and updates the native X11 window title.
- The dispatcher is killed after the GUI has processed the action but before completion is returned.
- Recovery uses X11 window observation (`xdotool getwindowname`) and verifies that the visible native-window state contains exactly one committed action.

This is intentionally a small deterministic GUI fixture: the research object is crash/recovery semantics, not visual grounding quality.

## Code experiment

`experiments/real/code.ts`

- Creates a real isolated Git repository.
- A worker edits `feature.txt`, stages it, and creates a real Git commit.
- The worker is killed immediately after `git commit`.
- The vanilla baseline repeats the edit/commit and therefore creates a duplicate marker.
- LHIC-Core reloads its durable ledger, observes the repository, verifies both file content and Git history, and does not create a second commit.

This experiment tests code-workspace side effects using durable filesystem and Git state rather than a simulated code action.

## Metrics

Each surface emits `LHIC_REAL_RESULT=<json>` with:

- side-effect count;
- duplicate side-effect count;
- first ledger state;
- recovered ledger state;
- dispatcher count;
- observation count;
- verifier count;
- recovery success count.

`experiments/real/run-all.ts` aggregates all surfaces into:

```text
artifacts/real-failure-injection-results.json
```

The schema is `lhic-real-failure-injection-suite-v1`.

## Reproduction

Core/code experiment:

```bash
npm test
LHIC_REAL_TRIALS=3 npm run experiment:code
```

Browser experiment:

```bash
npm install --no-save --ignore-scripts playwright@1.62.1
npx playwright install --with-deps chromium
LHIC_REAL_TRIALS=3 npm run experiment:browser
```

Desktop experiment on Debian/Ubuntu:

```bash
sudo apt-get install xvfb xauth xdotool python3-tk
LHIC_REAL_TRIALS=3 npm run experiment:desktop
```

Full suite:

```bash
LHIC_REAL_TRIALS=3 npm run experiment:real
```

The GitHub workflow `.github/workflows/real-failure-injection.yml` pins Playwright and runs the full suite on Ubuntu 24.04.

## Claim boundary

These experiments provide **real-surface internal-validity evidence** for the side-effect recovery protocol. They still use controlled fixtures, so they do not establish general agent capability, real-web robustness, OSWorld performance, SWE-bench performance, or universal safety.

The next external-validity layer should reuse the same failure injector around real benchmark adapters while preserving official benchmark scoring.
