# Architecture

The controller uses a deterministic local Fast Path:

```text
intent → normalized UI state → local prediction → semantic action/skill → verifier → redacted trace → skill memory
```

`@lhic/browser` calls the Playwright SDK directly and observes DOM/accessibility metadata, console errors, and network state. It deliberately has no MCP, OCR, VLM, mouse-coordinate, or model integration.

`@lhic/controller` routes only low-risk predictions with confidence at least 0.8 to the Fast Path. Ambiguity goes to a provider-agnostic Slow Path interface, while high or unknown risk asks the user for confirmation.

The executor repeats this check at its own boundary and binds an approval to a hash of the exact action with a short expiry. In production, `createProductionExecutor` consumes the validated runtime configuration so navigation targets, timeouts, and trace location cannot be silently omitted by a caller.

`@lhic/verifier` records DOM, URL, network, and file evidence. `@lhic/trace` persists that evidence as redacted JSONL. `@lhic/memory` promotes a skill only after successful verifier evidence.
