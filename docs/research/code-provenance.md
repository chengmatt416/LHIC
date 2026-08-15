# Code Provenance and Academic Extraction

The academic artifact was extracted from `feature/sota-improvements` at product commit `f519c94eadee15d0f4b4995995f6054326a39c24`.

The goal is not a source mirror. Each academic module preserves a research invariant while removing product-only dependencies, UI glue, provider-specific code, and release infrastructure.

| Academic file | Product source used as design/source basis | Academic transformation |
|---|---|---|
| `src/model.ts` | `packages/schema/src/receipt.ts` | Keeps side-effect taxonomy, approval scope, receipt authority, and evidence semantics; removes monorepo action types and product trace fields not needed for the paper. |
| `src/policy.ts` | `packages/security/src/side-effect-classification.ts` | Keeps conservative risk ordering and `planner may raise, never lower` invariant; replaces product UI/action heuristics with a small research action schema. |
| `src/approval.ts` | `packages/security/src/approval-scope.ts` | Keeps exact/plan/read-only/origin-class scopes, expiration, high-risk exclusions, and fail-closed semantics; removes signature/KMS and product approval object coupling. |
| `src/ledger.ts` | `packages/ledger/src/side-effect-ledger.ts` | Keeps durable state transitions, ambiguous recovery query, and terminal verified behavior; replaces SQLite with atomic JSON replacement to minimize artifact dependencies. |
| `src/recovery.ts` | `packages/ledger/src/side-effect-ledger.ts` + recovery rules documented in `docs/sota/side-effect-recovery.md` | Makes the observe-before-retry decision explicit as a small pure function. |
| `src/receipt.ts` | `packages/schema/src/receipt.ts` | Makes execution/verification authority separation executable and prevents empty-evidence verification. |
| `src/memory.ts` | product memory/trust and learning promotion gates | Reduces the product memory system to the paper-facing rule: trusted reuse needs verifier-backed provenance, independent tasks, holdout success, and non-stale anchors. |
| `src/kernel.ts` | composition across product controller/security/ledger/verifier layers | Provides a minimal reference composition for evaluation without OMP, Electron, browser packaging, or provider setup. |

The product branch remains the engineering implementation. The academic branch is the minimal reproducible research artifact and should be evaluated on its stated invariants and failure-injection protocol.
