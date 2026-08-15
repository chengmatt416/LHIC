# Academic Positioning

## Core question

How can autonomous agents perform real computer actions when tool calls are non-atomic, side effects may be irreversible, and model outputs are not trustworthy execution evidence?

## Proposed contribution

LHIC-Core is an execution kernel that separates planning from execution truth. It combines:

1. policy and approval gates;
2. durable side-effect state;
3. postcondition verification;
4. authority-aware receipts;
5. trust-aware memory promotion;
6. workspace state mediation.

## Novelty boundary

LHIC-Core should not be positioned as another planning model or another coding agent. OMP, browser control, desktop adapters, and model providers are execution adapters. The academic object is the runtime contract around them.

## Strongest publishable angle

The strongest angle is **crash-consistent side-effect semantics for agent execution**. The work should show that the same planner becomes safer and more reliable when wrapped by a runtime that treats side effects as durable, observable state transitions rather than atomic tool-call returns.

## Related-work categories to compare against

- Tool-call verification and non-atomic failure handling.
- Runtime safety interception for agent tool use.
- Transactional or contract-based tool execution.
- Computer-use benchmarks with long-horizon failure modes.
- Multi-agent shared-workspace state management.
- Memory/skill learning under trust and staleness constraints.

## Main claim to avoid

Do not claim general SOTA agent performance without official benchmark output. The research claim is reliability under failure injection and adversarial execution conditions.
