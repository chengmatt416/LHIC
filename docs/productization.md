# LHIC productization and release readiness

LHIC separates repository productization from external publication. Passing the candidate gate means the repository contains the required install, data-control, packaging, validation, and release machinery. It does not mean npm packages or signed Desktop installers have already been published.

## Machine-readable source of truth

`productization-manifest.json` binds each distributable artifact to:

- its package name, package file, and exact semantic version;
- its current status;
- the only accepted release-tag prefix;
- its release workflow and protected GitHub environment;
- supported release platforms;
- files that must exist as normal, non-symlinked repository files;
- external credentials and approvals that cannot be stored in the repository.

`release-manifest.json` remains the compact release-status list. The product readiness checker rejects disagreements between the two manifests or package metadata.

## Candidate mode

Run:

```bash
npm run check:product-readiness
```

Candidate mode fails closed when any of the following is true:

- a manifest has an unsupported schema, unknown key, duplicate identity, invalid path, or invalid version;
- a package name or version differs from the manifests;
- a required file is missing, is a symbolic link, or is not a normal file;
- a permanent CI gate grants write access, pushes commits, or formats repository files;
- a temporary finalizer or diagnostic path remains;
- the npm release workflow lacks exact tags, OIDC, provenance, protected environment, or published-registry smoke tests;
- the Desktop release workflow lacks protected environments, all three platforms, macOS notarization verification, Windows Authenticode verification, combined checksums, or GitHub Release publication;
- the root CI or Product readiness gate does not execute the machine-readable checks.

The successful report contains the remaining external requirements. Those entries are obligations, not passed checks.

## Release mode

Release mode is intended only for protected GitHub Actions environments:

```bash
node scripts/check-product-readiness.mjs \
  --mode release \
  --artifact desktop \
  --tag desktop-v0.1.4 \
  --platform macos
```

Every release requires:

- an exact tag equal to the manifest prefix plus package version;
- `CI=true`;
- a full lowercase `GITHUB_SHA`;
- `GITHUB_REF_NAME` equal to the exact tag;
- the artifact's protected release-environment name.

Additional requirements are platform-specific.

### npm

- GitHub OIDC request variables must be present;
- `NPM_CONFIG_PROVENANCE=true`;
- the workflow must run in the protected `npm-release` environment;
- both scoped and compatibility packages must be published in one workflow and pass registry smoke tests.

### macOS

- a Developer ID signing credential through `CSC_LINK` or `CSC_NAME`;
- a password when `CSC_LINK` is used;
- Apple API-key, Apple ID, or keychain-profile notarization credentials;
- a nonempty, normal Apple API key file when API-key notarization is selected;
- successful `codesign` and Gatekeeper `spctl` assessment after packaging.

### Windows

- an Authenticode certificate through `WIN_CSC_LINK` or `CSC_LINK`;
- its password;
- successful `Get-AuthenticodeSignature` status `Valid` on the exact NSIS installer.

### Linux

- approval through the protected `desktop-release` environment;
- repository/environment variable `LHIC_LINUX_RELEASE_APPROVED=true`;
- successful runtime and package verification.

## Desktop release asset contract

A successful `desktop-v0.1.4` run must produce exactly:

```text
lhic-control-center-0.1.4-arm64.dmg
lhic-control-center-0.1.4-x64.AppImage
lhic-control-center-0.1.4-x64.deb
lhic-control-center-0.1.4-x64.dmg
lhic-control-center-0.1.4-x64.exe
SHA256SUMS-0.1.4.txt
```

The publish job rejects missing or extra installer assets before generating the checksum manifest. The CLI Desktop installer independently accepts only the highest stable `desktop-vX.Y.Z` release, exact platform/version/architecture filenames, one checksum manifest, one matching installer, and trusted GitHub download paths.

## External setup still required

Repository productization cannot create or approve external credentials. Before the first real release, a repository administrator must:

1. create protected GitHub environments named `npm-release` and `desktop-release`;
2. configure npm trusted publishing for `@pinyencheng/lhic` and `lhic`;
3. configure Apple Developer ID and notarization secrets;
4. configure a Windows Authenticode certificate and password;
5. set `LHIC_LINUX_RELEASE_APPROVED=true` in the protected Desktop environment;
6. select the exact validated commit and create the matching tags;
7. observe all publication and post-publication smoke tests succeed.

Do not change an artifact status to `released` until its external release and verification workflow have actually passed. A signed release is not proven by the presence of a workflow or by candidate-mode success.
