# Market research and benchmark strategy

## Evidence-based opportunity

The strongest current product hypothesis is not general web-agent SOTA. It is reliable, low-latency execution of known browser workflows through semantic controls, verifier evidence, local memory, and explicit high-risk approval.

The local selector-resilience ablation supports this narrow hypothesis: its semantic treatment handles label, role/ARIA, name, placeholder, and wrapping variations that a deliberately fixed selector does not. It is not evidence against a public agent baseline.

## External benchmark fit

| Benchmark                    | Fit with current product                                                                                                       | Gap before credible comparison                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WorkArena L1                 | Strongest first target: routine forms, lists, menus, knowledge base, and catalog interactions align with the Fast Path skills. | An initial search-only AgentLab adapter exists, but forms, lists, menus, recovery, gated ServiceNow instances, and full-suite execution are still required. |
| WorkArena L2/L3              | Good long-horizon product direction.                                                                                           | Current controller does not yet demonstrate multi-step planning, task decomposition, or recovery across composite tasks.                                    |
| WebArena / WebArena-Verified | Important broad web-agent comparison.                                                                                          | Current product lacks a general BrowserGym observation-to-action agent and multi-site task policy.                                                          |
| OSWorld                      | Not a current fit.                                                                                                             | This project implements browser automation, not cross-desktop control.                                                                                      |

## Research findings

- [AgentLab](https://github.com/ServiceNow/AgentLab) is the preferred experiment framework for WebArena and supports WorkArena L1/L2/L3. Its published setup requires Python 3.11 or 3.12, Playwright, an agent implementation compatible with its `AgentArgs` API, and benchmark-specific setup.
- [WorkArena](https://github.com/ServiceNow/WorkArena) is a practical initial wedge: it measures knowledge-work browser tasks and its maintainers recommend AgentLab for evaluation and unified leaderboard reporting. Access to its ServiceNow instances is gated.
- [BrowserGym](https://github.com/ServiceNow/BrowserGym) exposes the benchmark action loop separately from a browser agent's internal Playwright executor. LHIC now includes a deliberately limited semantic-BID search adapter as a debug starting point, but a local Playwright test alone is not a valid external benchmark run.

## Submission decision rule

Do not submit the local ablation. A leaderboard submission is permitted only after all of these are true:

1. An AgentLab-compatible LHIC agent runs an unmodified full external suite with the adapter source committed and pinned.
2. The runner image digest, benchmark commit, seed, model/version configuration, all task results, and traces are published.
3. The result materially beats the current public comparator under the same suite and protocol, not a constructed baseline.
4. A separate party reproduces the result.
5. The submitted evidence passes `lhic bench validate-evidence` and an authorised human approves the external submission.

The local ablation is an input to prioritisation only. It identifies semantic target resolution as a potential differentiation, but its fixed-selector treatment makes `externalSubmissionEligible` permanently false.

## Next experiment sequence

1. Extend and validate the BrowserGym/AgentLab adapter on a single WorkArena L1 debug task with `n_jobs=1`.
2. Once the adapter supports the complete task protocol, run the unmodified WorkArena L1 suite with a fixed seed and strict reproducibility.
3. Compare only against the current official leaderboard entry with matched configuration; publish a negative result if it does not win.
4. Extend to WorkArena++ and WebArena-Verified only after the L1 evidence demonstrates that the semantic Fast Path helps rather than harms task completion.

Check environment readiness without reading or printing credentials:

```bash
lhic bench readiness workarena
lhic bench readiness webarena
```
