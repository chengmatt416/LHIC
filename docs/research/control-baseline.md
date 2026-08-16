# Matched Control Baseline for the Flagship Failure-Injection Experiment

This document defines the control group used in the presentation-facing comparison. It does not add a new public benchmark claim; it makes explicit the matched comparison already implemented by the real-surface failure-injection harness.

## Research question

When a real external side effect has already committed but the completion response is lost, does LHIC-Core's durable ambiguity plus observe-before-replay recovery reduce duplicate side effects relative to blind retry?

## Matched experimental design

The control and LHIC conditions hold the following constant:

- the same logical action;
- the same controlled browser, desktop, or Git fixture;
- the same external side effect;
- the same injected post-commit / pre-response failure window;
- the same trial count: 10 trials per surface, 30 total.

The manipulated variable is only the recovery policy after completion is lost.

### Control: blind retry

After the committed action returns no reliable completion response, the control condition dispatches the same logical action again without first establishing external state.

### Treatment: LHIC-Core

LHIC-Core has already persisted `possibly_committed` before dispatch. After the response is lost, it reloads durable state, observes the external world, verifies the intended postcondition, and blocks replay when the effect is present.

## Result

| Surface | Trials | Blind-retry duplicate trials | LHIC duplicate trials |
|---|---:|---:|---:|
| Browser / Chromium | 10 | 10 / 10 | 0 / 10 |
| Desktop / X11 + Tk | 10 | 10 / 10 | 0 / 10 |
| Code / Git | 10 | 10 / 10 | 0 / 10 |
| **Total** | **30** | **30 / 30** | **0 / 30** |

Thus the matched control produces a duplicate side effect in 100% of the 30 flagship trials, while LHIC-Core produces zero duplicate side effects in the same matched fixtures.

For the same logical action, the control condition commits two side effects per trial after blind retry, while LHIC-Core commits exactly one side effect per trial and reaches verified recovery in all 30 LHIC trials.

## Interpretation

This comparison supports a narrow causal systems claim within the controlled fixtures: under the injected post-commit / pre-response failure window, changing the recovery policy from blind retry to durable ambiguity + observe-before-replay eliminates the duplicate side effect observed in the control group.

It does not establish general computer-use accuracy, open-world superiority, or a public benchmark score.

## Relationship to the randomized campaign

The 108-trial randomized campaign is a robustness test of LHIC-Core across additional failure semantics and timing schedules. It is not used as the matched control comparison. The flagship blind-retry experiment is the control-group evidence used to demonstrate LHIC-Core's advantage on duplicate replay.