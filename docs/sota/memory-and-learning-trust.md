# Memory and learning trust

Memory is namespaced (`verified_skill`, `selector`, `coding_context`,
`user_fact`, `recipe_candidate`) with explicit trust
(`verifier_backed`, `observed`, `model_extracted`, `user_provided`,
`shared_signed`). Fast Path may use only verifier-backed or
cryptographically verified shared records; lower-trust memory is labeled
and never promoted by serialization.

Code-anchored records lose confidence when anchored files change (0.1) or
disappear (0.25) and are marked stale. Verified recipes require >=3
INDEPENDENT runs (distinct task IDs; repeated same-task runs never count)
plus a passed holdout; parameterization strips PII and refuses extraction
when credential-like literals survive redaction.

Shared skills carry Ed25519 provenance (`lhic-shared-skill-provenance-v1`):
modified definitions invalidate signatures, unknown publishers stay
untrusted, revoked keys disqualify, and the snapshot apply guard refuses
silent replacement of stored skills. Promotion gates (one success never
promotes; holdout independence; no unverified Fast Path) are preserved.
