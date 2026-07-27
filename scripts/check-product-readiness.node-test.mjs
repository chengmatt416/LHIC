import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseProductReadinessArguments,
  validateCandidateRepository,
  validateReleaseEnvironment,
} from "./check-product-readiness.mjs";

const commitSha = "a".repeat(40);

const commonEnvironment = {
  CI: "true",
  GITHUB_SHA: commitSha,
};

test("candidate readiness validates the current repository", async () => {
  const report = await validateCandidateRepository();
  assert.equal(report.schemaVersion, "lhic-product-readiness-report-v1");
  assert.equal(report.mode, "candidate");
  assert.equal(report.passed, true);
  assert.ok(report.checks.length >= 4);
  assert.ok(report.externalRequirements.length >= 1);
});

test("argument parser keeps candidate and release modes exact", () => {
  assert.deepEqual(parseProductReadinessArguments([]), {
    mode: "candidate",
    manifestPath: "productization-manifest.json",
  });
  assert.deepEqual(
    parseProductReadinessArguments([
      "--mode",
      "release",
      "--artifact",
      "desktop",
      "--tag",
      "desktop-v0.1.4",
      "--platform",
      "linux",
    ]),
    {
      mode: "release",
      manifestPath: "productization-manifest.json",
      artifact: "desktop",
      tag: "desktop-v0.1.4",
      platform: "linux",
    },
  );
  assert.throws(
    () => parseProductReadinessArguments(["--mode", "candidate", "--tag", "x"]),
    /Candidate mode does not accept/u,
  );
  assert.throws(
    () => parseProductReadinessArguments(["--mode", "release"]),
    /requires --artifact/u,
  );
  assert.throws(
    () => parseProductReadinessArguments(["--unknown", "value"]),
    /unknown, duplicate, or empty/u,
  );
});

test("npm release requires exact tag, protected environment, and OIDC", async () => {
  const report = await validateReleaseEnvironment({
    artifactId: "cli",
    tag: "cli-v0.1.2",
    platform: "registry",
    environment: {
      ...commonEnvironment,
      GITHUB_REF_NAME: "cli-v0.1.2",
      LHIC_RELEASE_ENVIRONMENT: "npm-release",
      NPM_CONFIG_PROVENANCE: "true",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "present",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example",
    },
  });
  assert.equal(report.passed, true);
  assert.equal(report.artifact, "cli");
  await assert.rejects(
    validateReleaseEnvironment({
      artifactId: "cli",
      tag: "cli-v0.1.2",
      platform: "registry",
      environment: {
        ...commonEnvironment,
        GITHUB_REF_NAME: "cli-v0.1.2",
        LHIC_RELEASE_ENVIRONMENT: "npm-release",
        NPM_CONFIG_PROVENANCE: "true",
      },
    }),
    /ACTIONS_ID_TOKEN_REQUEST_TOKEN/u,
  );
  await assert.rejects(
    validateReleaseEnvironment({
      artifactId: "cli",
      tag: "cli-v9.9.9",
      platform: "registry",
      environment: {},
    }),
    /exactly cli-v0\.1\.2/u,
  );
});

test("macOS release requires signing and a real notarization key file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lhic-product-release-"));
  const keyFile = join(directory, "AuthKey.p8");
  await writeFile(keyFile, "private-key-fixture", { mode: 0o600 });
  try {
    const report = await validateReleaseEnvironment({
      artifactId: "desktop",
      tag: "desktop-v0.1.4",
      platform: "macos",
      environment: {
        ...commonEnvironment,
        GITHUB_REF_NAME: "desktop-v0.1.4",
        LHIC_RELEASE_ENVIRONMENT: "desktop-release",
        CSC_LINK: "present",
        CSC_KEY_PASSWORD: "present",
        APPLE_API_KEY: keyFile,
        APPLE_API_KEY_ID: "present",
        APPLE_API_ISSUER: "present",
      },
    });
    assert.equal(report.platform, "macos");
    assert.doesNotMatch(JSON.stringify(report), /private-key-fixture/u);

    await assert.rejects(
      validateReleaseEnvironment({
        artifactId: "desktop",
        tag: "desktop-v0.1.4",
        platform: "macos",
        environment: {
          ...commonEnvironment,
          GITHUB_REF_NAME: "desktop-v0.1.4",
          LHIC_RELEASE_ENVIRONMENT: "desktop-release",
          CSC_LINK: "present",
          CSC_KEY_PASSWORD: "present",
          APPLE_API_KEY: join(directory, "missing.p8"),
          APPLE_API_KEY_ID: "present",
          APPLE_API_ISSUER: "present",
        },
      }),
      /ENOENT|APPLE_API_KEY/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Windows and Linux releases fail closed on platform approval", async () => {
  const windowsReport = await validateReleaseEnvironment({
    artifactId: "desktop",
    tag: "desktop-v0.1.4",
    platform: "windows",
    environment: {
      ...commonEnvironment,
      GITHUB_REF_NAME: "desktop-v0.1.4",
      LHIC_RELEASE_ENVIRONMENT: "desktop-release",
      WIN_CSC_LINK: "present",
      WIN_CSC_KEY_PASSWORD: "present",
    },
  });
  assert.equal(windowsReport.platform, "windows");

  await assert.rejects(
    validateReleaseEnvironment({
      artifactId: "desktop",
      tag: "desktop-v0.1.4",
      platform: "windows",
      environment: {
        ...commonEnvironment,
        GITHUB_REF_NAME: "desktop-v0.1.4",
        LHIC_RELEASE_ENVIRONMENT: "desktop-release",
        WIN_CSC_LINK: "present",
      },
    }),
    /certificate and password/u,
  );

  const linuxReport = await validateReleaseEnvironment({
    artifactId: "desktop",
    tag: "desktop-v0.1.4",
    platform: "linux",
    environment: {
      ...commonEnvironment,
      GITHUB_REF_NAME: "desktop-v0.1.4",
      LHIC_RELEASE_ENVIRONMENT: "desktop-release",
      LHIC_LINUX_RELEASE_APPROVED: "true",
    },
  });
  assert.equal(linuxReport.platform, "linux");

  await assert.rejects(
    validateReleaseEnvironment({
      artifactId: "desktop",
      tag: "desktop-v0.1.4",
      platform: "linux",
      environment: {
        ...commonEnvironment,
        GITHUB_REF_NAME: "desktop-v0.1.4",
        LHIC_RELEASE_ENVIRONMENT: "desktop-release",
      },
    }),
    /LHIC_LINUX_RELEASE_APPROVED/u,
  );
});

test("release validation rejects cross-artifact platforms and stale refs", async () => {
  await assert.rejects(
    validateReleaseEnvironment({
      artifactId: "cli",
      tag: "cli-v0.1.2",
      platform: "linux",
      environment: {},
    }),
    /does not support release platform/u,
  );
  await assert.rejects(
    validateReleaseEnvironment({
      artifactId: "desktop",
      tag: "desktop-v0.1.4",
      platform: "linux",
      environment: {
        ...commonEnvironment,
        GITHUB_REF_NAME: "desktop-v0.1.3",
        LHIC_RELEASE_ENVIRONMENT: "desktop-release",
        LHIC_LINUX_RELEASE_APPROVED: "true",
      },
    }),
    /GITHUB_REF_NAME/u,
  );
});
