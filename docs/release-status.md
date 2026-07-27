# Release status

`release-manifest.json` is the compact machine-checked status list for artifacts
that may be distributed outside this repository. `productization-manifest.json`
binds those artifacts to exact release workflows, protected environments,
required files, supported platforms, and remaining external requirements.

Run both checks before packaging or publication:

```bash
npm run check:release-versions
npm run check:product-readiness
```

| Artifact            | Version | Status            | Notes                                                                                                                         |
| ------------------- | ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@pinyencheng/lhic` | 0.1.2   | Release candidate | npm CLI; publish only from exact `cli-v0.1.2` in the protected `npm-release` environment, followed by registry smoke checks. |
| `lhic`              | 0.1.2   | Release candidate | Compatibility wrapper; publish from the same trusted-publishing workflow as the scoped CLI.                                  |
| `@lhic/desktop`     | 0.1.4   | Release candidate | Native Control Center; requires signed/notarized macOS, Authenticode Windows, approved Linux, checksums, and GitHub Release. |

The root package and packages under `packages/*` are private workspace control
versions. Their `0.1.0` versions are not user-facing release numbers. The CLI
and Desktop may therefore advance independently, but every distributable
artifact must be listed in both manifests and match its package declaration.

A release-candidate status means the repository-side build, validation, and
release machinery exists. It does not mean the package or installer has been
published. Do not change an artifact to `released` until the external protected
workflow and post-publication verification have actually succeeded.

See [productization and release readiness](productization.md) for the exact
candidate/release gates and external credential requirements. See
[the CLI 0.1.2 release notes](release-notes-0.1.2.md) for CLI-specific context.
