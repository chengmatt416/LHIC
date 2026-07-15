# Controlled advantage simulation

Run the local semantic-targeting ablation with a fixed task count and seed:

```bash
lhic bench simulate resilience 100 20260715
```

The simulator renders equivalent form-completion tasks in five UI layouts. It compares:

- `directSemantic`: LHIC's label, role, name, and placeholder-aware `fillForm` skill, with DOM verification of the saved primary field.
- `staticSelectorBaseline`: an intentionally limited `input[name="full_name"]` policy, which represents a brittle fixed-selector implementation.

Both treatments operate on fresh copies of the same rendered task and must pass the same DOM result verifier. The report calls a gap of at least 50 percentage points, with semantic success at least 95%, an `observedLargeControlledAdvantage`.

This is an engineering ablation, not an external-agent comparison. Its baseline is intentionally scoped and it is **never** eligible for benchmark submission or a SOTA claim. Use it to decide whether selector resilience is worth evaluating on an unmodified external suite. Follow [the external benchmark protocol](../benchmarks/README.md) for any public comparison.
