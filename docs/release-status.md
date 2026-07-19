# Release status

`release-manifest.json` is the machine-checked source of truth for artifacts
that may be distributed outside this repository. Run
`npm run check:release-versions` before packaging or publication.

| Artifact            | Version | Status            | Notes                                                               |
| ------------------- | ------- | ----------------- | ------------------------------------------------------------------- |
| `@pinyencheng/lhic` | 0.1.2   | Release candidate | npm CLI; publication and clean-room registry smoke remain required. |
| `lhic`              | 0.1.2   | Release candidate | Compatibility wrapper; publish only after the scoped CLI.           |
| `@lhic/desktop`     | 0.1.4   | Development build | Native Control Center; not evidence of a published npm CLI release. |

The root package and packages under `packages/*` are private workspace control
versions. Their `0.1.0` versions are not user-facing release numbers. The CLI
and desktop may therefore advance independently, but every distributable
artifact must be listed in the manifest and match its package declaration.

See [the CLI 0.1.2 release notes](release-notes-0.1.2.md) for its remaining
publication gates.
