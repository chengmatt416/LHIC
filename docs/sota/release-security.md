# Release security

Gates: protected release branch policy (admin action), required CI,
dependency audit at high threshold, `npm run sbom` (SPDX 2.3 from the
production tree), SHA-256 release manifests with optional detached Ed25519
signatures (`verify-sha256-manifest.mjs`), OMP binary digest recorded in
release metadata, npm `--provenance` publication, no release from a dirty
worktree (release tag checks), and a secret scan over reachable history.

The experimental HTTP control plane is explicitly labeled and not wired
into the MCP entrypoint; durable task state lives in the lease-based
`DistributedTaskQueue` and encrypted `DurableWorkflowStore`. The
`node_modules_bak` backup tree was removed from source control.
