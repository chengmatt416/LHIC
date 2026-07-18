# Architecture

The controller uses a deterministic local Fast Path:

```text
intent → normalized UI state → local prediction → semantic action/skill → verifier → redacted trace → skill memory
```

`@lhic/browser` calls the Playwright SDK directly and observes DOM/accessibility metadata, console errors, and network state. It deliberately has no MCP, OCR, VLM, mouse-coordinate, or model integration.

`@lhic/skills` also owns a separately scoped global-desktop executor. It uses
native OS APIs rather than browser or MCP fallbacks: AppleScript/System Events
on macOS, PowerShell with Windows Forms/user32 on Windows, and `xdotool` plus
`gtk-launch` on Linux X11. Global actions are never Fast Path browser actions:
they require a human approval bound to the exact action and a post-action
active-window or process-running verifier. The executor records redacted trace
metadata only; typed text is omitted.

`@lhic/mcp-server` is a separate external-agent integration for Antigravity.
It exposes a small browser computer-use MCP surface that feeds validated
semantic actions into the same local executor; it is outside the Fast Path and
does not make Antigravity a Slow Path provider.

An external harness may also compile one `browser-plan-v1` with its LLM and
send it to the MCP batch executor. That single planning request happens before
LHIC Fast execution: the local batch runner then executes direct Playwright
actions, verifier checks, and human approval pauses without model calls. Slow
Path remains the one-action/one-observation tool loop, so the model can
intervene after every action result.

`@lhic/controller` routes only low-risk predictions with confidence at least 0.8 to the Fast Path. Ambiguity goes to a provider-agnostic Slow Path interface, while high or unknown risk asks the user for confirmation.

The executor repeats this check at its own boundary and binds an approval to a hash of the exact action with a short expiry. In production, `createProductionExecutor` consumes the validated runtime configuration so navigation targets, timeouts, and trace location cannot be silently omitted by a caller.

`@lhic/verifier` records DOM, URL, network, and file evidence. `@lhic/trace` persists that evidence as redacted JSONL. `@lhic/memory` promotes a skill only after successful verifier evidence.

When enabled, `@lhic/shared-skills` mirrors approved Appwrite registry records
into separate SQLite tables and keeps an authenticated submission outbox. The
sync happens before a runtime begins and never during Fast Path execution. The
controller can resolve one cached, low-risk browser skill only when its
operation key and privacy-preserving UI fingerprint match uniquely; all other
requests continue through the existing builtin or Slow Path policy.

## Multi-path controller

LHIC also provides a SIMA 2-inspired, deterministic multi-path scheduler. It
does not replace the local Fast Path with a vision-language agent. Instead, it
chooses a capability path separately for `observe`, `interpret`, `plan`,
`execute`, `verify`, and `recover` stages:

```text
low-risk unique skill → local_fast → local executor → verifier
verifier/selector failure → local_recovery (once) → re-observe
remaining ambiguity → budgeted slow_planner → validated stage plan → local executor
missing DOM/AX observation → deliberative-only slow_vision_planner
```

Every task carries an execution profile. `fast_only` permits only local Fast
Path and one local recovery; `balanced` permits one text planner request;
`deliberative` permits up to three planner calls and one pre-redacted visual
observation. Profiles can be restricted per task, never expanded. Risk,
approval, verifier, executor, and navigation rules take precedence over all
paths. Fast Path never calls a model, MCP server, or remote planner.

The scheduler is initially controlled with `LHIC_PATH_ROUTING_MODE=legacy`.
Use `shadow` to record routing evidence without changing legacy execution;
only then set `enabled` for an explicitly selected profile.

## Controlled learning

Verified Slow Path executions create candidate skills, not Fast Path skills.
A candidate requires three independent task IDs and a successful deterministic
holdout evaluation in a local fixture, allowlisted sandbox, or registered test
account before it is promoted. An offline evaluation worker cannot target an
unallowlisted production site and cannot create verifier evidence itself.

Task summaries compact completed steps, redacted verifier evidence, failures,
and the current origin/path before any planner request. `DurableTaskSummaryStore`
persists only that compact redacted summary in SQLite; it has no columns for
raw traces, screenshots, browser storage, or credentials. Route traces record
the path, reason, profile, and budget consumption without logging inputs or
image bytes.
