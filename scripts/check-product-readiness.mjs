import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const manifestSchema = "lhic-productization-manifest-v1";
const reportSchema = "lhic-product-readiness-report-v1";
const releaseStatuses = new Set([
  "development-build",
  "release-candidate",
  "released",
]);
const artifactKinds = new Set(["npm", "desktop"]);
const releasePlatforms = new Set([
  "registry",
  "linux",
  "macos",
  "windows",
]);
const maximumArtifacts = 16;
const maximumListItems = 64;

export function parseProductReadinessArguments(argumentsList) {
  const allowed = new Set([
    "--mode",
    "--artifact",
    "--tag",
    "--platform",
    "--manifest",
  ]);
  if (argumentsList.length % 2 !== 0) {
    throw new Error("Product readiness arguments must use flag/value pairs.");
  }
  const values = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag || !value || !allowed.has(flag) || values.has(flag)) {
      throw new Error(
        "Product readiness contains an unknown, duplicate, or empty flag.",
      );
    }
    values.set(flag, value);
  }
  const mode = values.get("--mode") ?? "candidate";
  if (mode !== "candidate" && mode !== "release") {
    throw new Error("Product readiness mode must be candidate or release.");
  }
  const manifestPath =
    values.get("--manifest") ?? "productization-manifest.json";
  const artifact = values.get("--artifact");
  const tag = values.get("--tag");
  const platform = values.get("--platform");
  if (mode === "candidate" && (artifact || tag || platform)) {
    throw new Error(
      "Candidate mode does not accept --artifact, --tag, or --platform.",
    );
  }
  if (mode === "release" && (!artifact || !tag || !platform)) {
    throw new Error(
      "Release mode requires --artifact, --tag, and --platform.",
    );
  }
  return {
    mode,
    manifestPath,
    ...(artifact ? { artifact } : {}),
    ...(tag ? { tag } : {}),
    ...(platform ? { platform } : {}),
  };
}

export async function validateCandidateRepository({
  root = process.cwd(),
  manifestPath = "productization-manifest.json",
} = {}) {
  const repositoryRoot = resolve(root);
  const manifest = await readJson(
    repositoryRoot,
    manifestPath,
    "productization manifest",
  );
  const normalized = validateProductizationManifest(manifest);
  const checks = [];
  const releaseManifest = validateReleaseManifest(
    await readJson(
      repositoryRoot,
      "release-manifest.json",
      "release manifest",
    ),
  );

  for (const gate of normalized.permanentGates) {
    const workflow = await readNormalTextFile(repositoryRoot, gate);
    if (!/^permissions:\s*\n\s{2}contents:\s*read\s*$/mu.test(workflow)) {
      throw new Error(`Permanent gate ${gate} must grant contents: read.`);
    }
    for (const forbidden of [
      /^\s*contents:\s*write\s*$/mu,
      /\bgit\s+push\b/u,
      /\bprettier\s+--write\b/u,
    ]) {
      if (forbidden.test(workflow)) {
        throw new Error(`Permanent gate ${gate} contains a write capability.`);
      }
    }
  }
  checks.push({
    id: "permanent-gates-read-only",
    passed: true,
    detail: `${normalized.permanentGates.length} permanent gates are read-only.`,
  });

  for (const forbiddenPath of normalized.forbiddenTemporaryPaths) {
    if (await pathExists(repositoryRoot, forbiddenPath)) {
      throw new Error(
        `Temporary productization path must not remain: ${forbiddenPath}.`,
      );
    }
  }
  checks.push({
    id: "temporary-tools-absent",
    passed: true,
    detail: `${normalized.forbiddenTemporaryPaths.length} temporary paths are absent.`,
  });

  const artifactIds = new Set();
  const packageNames = new Set();
  for (const artifact of normalized.artifacts) {
    if (artifactIds.has(artifact.id)) {
      throw new Error(`Duplicate product artifact id: ${artifact.id}.`);
    }
    if (packageNames.has(artifact.packageName)) {
      throw new Error(
        `Duplicate product package name: ${artifact.packageName}.`,
      );
    }
    artifactIds.add(artifact.id);
    packageNames.add(artifact.packageName);
    const packageJson = exactRecord(
      await readJson(
        repositoryRoot,
        artifact.packagePath,
        artifact.packageName,
      ),
      undefined,
      `${artifact.packageName} package`,
    );
    if (packageJson.name !== artifact.packageName) {
      throw new Error(
        `${artifact.packagePath} package name does not match ${artifact.packageName}.`,
      );
    }
    if (packageJson.version !== artifact.version) {
      throw new Error(
        `${artifact.packageName} version does not match the productization manifest.`,
      );
    }
    const releaseEntry = releaseManifest.artifacts.find(
      (entry) => entry.name === artifact.packageName,
    );
    if (!releaseEntry) {
      throw new Error(
        `${artifact.packageName} is missing from release-manifest.json.`,
      );
    }
    if (
      releaseEntry.packagePath !== artifact.packagePath ||
      releaseEntry.version !== artifact.version ||
      releaseEntry.status !== artifact.status
    ) {
      throw new Error(
        `${artifact.packageName} release and productization manifests disagree.`,
      );
    }
    for (const requiredFile of artifact.requiredFiles) {
      await assertNormalFile(repositoryRoot, requiredFile);
    }
    if (!artifact.requiredFiles.includes(artifact.releaseWorkflow)) {
      throw new Error(
        `${artifact.id} release workflow must be included in requiredFiles.`,
      );
    }
    const releaseWorkflow = await readNormalTextFile(
      repositoryRoot,
      artifact.releaseWorkflow,
    );
    if (artifact.kind === "npm") {
      validateNpmReleaseWorkflow(releaseWorkflow, artifact);
    } else {
      validateDesktopReleaseWorkflow(releaseWorkflow, artifact);
    }
  }
  checks.push({
    id: "artifact-manifests-consistent",
    passed: true,
    detail: `${normalized.artifacts.length} product artifacts match their package metadata and release manifest.`,
  });

  const rootPackage = exactRecord(
    await readJson(repositoryRoot, "package.json", "root package"),
    undefined,
    "root package",
  );
  const scripts = exactRecord(rootPackage.scripts, undefined, "root scripts");
  for (const requiredScript of [
    "check:product-readiness",
    "test:product-readiness",
    "ci",
  ]) {
    if (typeof scripts[requiredScript] !== "string") {
      throw new Error(`Root package is missing ${requiredScript}.`);
    }
  }
  if (!scripts.ci.includes("check:product-readiness")) {
    throw new Error("Root CI must execute check:product-readiness.");
  }
  const productGate = await readNormalTextFile(
    repositoryRoot,
    ".github/workflows/product-readiness.yml",
  );
  for (const requiredText of [
    "check:product-readiness",
    "test:product-readiness",
    "apps/cli/src/installer.test.ts",
    "apps/cli/src/product-data.test.ts",
  ]) {
    if (!productGate.includes(requiredText)) {
      throw new Error(
        `Product readiness gate must include ${requiredText}.`,
      );
    }
  }
  checks.push({
    id: "candidate-gate-integrated",
    passed: true,
    detail: "Candidate readiness is enforced by root CI and the product gate.",
  });

  return {
    schemaVersion: reportSchema,
    mode: "candidate",
    passed: true,
    repository: normalized.repository,
    artifact: null,
    platform: null,
    checks,
    externalRequirements: normalized.artifacts.flatMap((artifact) =>
      artifact.externalRequirements.map((requirement) => ({
        artifact: artifact.id,
        requirement,
      })),
    ),
  };
}

export async function validateReleaseEnvironment({
  root = process.cwd(),
  manifestPath = "productization-manifest.json",
  artifactId,
  tag,
  platform,
  environment = process.env,
}) {
  const repositoryRoot = resolve(root);
  const manifest = validateProductizationManifest(
    await readJson(
      repositoryRoot,
      manifestPath,
      "productization manifest",
    ),
  );
  const artifact = manifest.artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) {
    throw new Error(`Unknown release artifact: ${artifactId}.`);
  }
  if (artifact.status === "development-build") {
    throw new Error(`${artifact.id} is not a release candidate.`);
  }
  if (!artifact.releasePlatforms.includes(platform)) {
    throw new Error(
      `${artifact.id} does not support release platform ${platform}.`,
    );
  }
  const expectedTag = `${artifact.tagPrefix}${artifact.version}`;
  if (tag !== expectedTag) {
    throw new Error(`Release tag must be exactly ${expectedTag}.`);
  }
  if (environment.LHIC_RELEASE_ENVIRONMENT !== artifact.releaseEnvironment) {
    throw new Error(
      `Release must run in the protected ${artifact.releaseEnvironment} environment.`,
    );
  }
  if (environment.CI !== "true") {
    throw new Error("Release validation requires CI=true.");
  }
  if (environment.GITHUB_REF_NAME !== expectedTag) {
    throw new Error("GITHUB_REF_NAME does not match the exact release tag.");
  }
  if (!/^[a-f0-9]{40}$/u.test(environment.GITHUB_SHA ?? "")) {
    throw new Error("GITHUB_SHA must be a full lowercase Git commit SHA.");
  }

  if (artifact.kind === "npm") {
    requireEnvironmentValue(environment, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    requireEnvironmentValue(environment, "ACTIONS_ID_TOKEN_REQUEST_URL");
    if (environment.NPM_CONFIG_PROVENANCE !== "true") {
      throw new Error("npm release requires NPM_CONFIG_PROVENANCE=true.");
    }
  } else if (platform === "macos") {
    const hasSigningCredential = Boolean(
      environment.CSC_LINK || environment.CSC_NAME,
    );
    if (!hasSigningCredential) {
      throw new Error("macOS release requires CSC_LINK or CSC_NAME.");
    }
    if (environment.CSC_LINK && !environment.CSC_KEY_PASSWORD) {
      throw new Error("macOS CSC_LINK requires CSC_KEY_PASSWORD.");
    }
    const hasApiKey = Boolean(
      environment.APPLE_API_KEY &&
        environment.APPLE_API_KEY_ID &&
        environment.APPLE_API_ISSUER,
    );
    const hasAppleId = Boolean(
      environment.APPLE_ID &&
        environment.APPLE_APP_SPECIFIC_PASSWORD &&
        environment.APPLE_TEAM_ID,
    );
    const hasKeychainProfile = Boolean(environment.APPLE_KEYCHAIN_PROFILE);
    if (!hasApiKey && !hasAppleId && !hasKeychainProfile) {
      throw new Error(
        "macOS release requires Apple notarization credentials.",
      );
    }
    if (hasApiKey) {
      await assertNonemptyNormalFile(
        resolve(repositoryRoot, environment.APPLE_API_KEY),
        "APPLE_API_KEY",
      );
    }
  } else if (platform === "windows") {
    const certificate = environment.WIN_CSC_LINK || environment.CSC_LINK;
    const password =
      environment.WIN_CSC_KEY_PASSWORD || environment.CSC_KEY_PASSWORD;
    if (!certificate || !password) {
      throw new Error(
        "Windows release requires an Authenticode certificate and password.",
      );
    }
  } else if (platform === "linux") {
    if (environment.LHIC_LINUX_RELEASE_APPROVED !== "true") {
      throw new Error(
        "Linux release requires LHIC_LINUX_RELEASE_APPROVED=true.",
      );
    }
  }

  return {
    schemaVersion: reportSchema,
    mode: "release",
    passed: true,
    repository: manifest.repository,
    artifact: artifact.id,
    platform,
    tag: expectedTag,
    version: artifact.version,
    commitSha: environment.GITHUB_SHA,
    checks: [
      {
        id: "exact-release-tag",
        passed: true,
        detail: expectedTag,
      },
      {
        id: "protected-release-environment",
        passed: true,
        detail: artifact.releaseEnvironment,
      },
      {
        id: "platform-credentials-present",
        passed: true,
        detail: `${platform} credential names are present; secret values are not reported.`,
      },
    ],
  };
}

function validateProductizationManifest(value) {
  const manifest = exactRecord(
    value,
    [
      "schemaVersion",
      "repository",
      "permanentGates",
      "forbiddenTemporaryPaths",
      "artifacts",
    ],
    "productization manifest",
  );
  if (manifest.schemaVersion !== manifestSchema) {
    throw new Error("Productization manifest schemaVersion is unsupported.");
  }
  if (manifest.repository !== "chengmatt416/LHIC") {
    throw new Error("Productization manifest repository is unsupported.");
  }
  const permanentGates = relativePathList(
    manifest.permanentGates,
    "permanentGates",
  );
  const forbiddenTemporaryPaths = relativePathList(
    manifest.forbiddenTemporaryPaths,
    "forbiddenTemporaryPaths",
  );
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("Productization artifacts must be an array.");
  }
  if (
    manifest.artifacts.length < 1 ||
    manifest.artifacts.length > maximumArtifacts
  ) {
    throw new Error(
      `Productization artifacts must contain 1-${maximumArtifacts} entries.`,
    );
  }
  const artifacts = manifest.artifacts.map((entry, index) => {
    const artifact = exactRecord(
      entry,
      [
        "id",
        "kind",
        "packageName",
        "packagePath",
        "version",
        "status",
        "tagPrefix",
        "releaseWorkflow",
        "releaseEnvironment",
        "releasePlatforms",
        "requiredFiles",
        "externalRequirements",
      ],
      `product artifact ${index}`,
    );
    const id = boundedIdentifier(artifact.id, `artifact ${index} id`);
    if (!artifactKinds.has(artifact.kind)) {
      throw new Error(`Product artifact ${id} kind is unsupported.`);
    }
    const packageName = boundedPackageName(
      artifact.packageName,
      `artifact ${id} packageName`,
    );
    const packagePath = relativePath(
      artifact.packagePath,
      `artifact ${id} packagePath`,
    );
    const version = semanticVersion(
      artifact.version,
      `artifact ${id} version`,
    );
    if (!releaseStatuses.has(artifact.status)) {
      throw new Error(`Product artifact ${id} status is unsupported.`);
    }
    const tagPrefix = boundedIdentifier(
      artifact.tagPrefix,
      `artifact ${id} tagPrefix`,
    );
    if (
      (artifact.kind === "npm" && tagPrefix !== "cli-v") ||
      (artifact.kind === "desktop" && tagPrefix !== "desktop-v")
    ) {
      throw new Error(`Product artifact ${id} tag prefix is invalid.`);
    }
    const releaseWorkflow = relativePath(
      artifact.releaseWorkflow,
      `artifact ${id} releaseWorkflow`,
    );
    const releaseEnvironment = boundedIdentifier(
      artifact.releaseEnvironment,
      `artifact ${id} releaseEnvironment`,
    );
    const platforms = stringList(
      artifact.releasePlatforms,
      `artifact ${id} releasePlatforms`,
      releasePlatforms,
    );
    const expectedPlatforms =
      artifact.kind === "npm"
        ? ["registry"]
        : ["linux", "macos", "windows"];
    if (
      JSON.stringify([...platforms].sort()) !==
      JSON.stringify(expectedPlatforms)
    ) {
      throw new Error(
        `Product artifact ${id} release platforms are incomplete.`,
      );
    }
    const requiredFiles = relativePathList(
      artifact.requiredFiles,
      `artifact ${id} requiredFiles`,
    );
    const externalRequirements = boundedStringList(
      artifact.externalRequirements,
      `artifact ${id} externalRequirements`,
    );
    return {
      id,
      kind: artifact.kind,
      packageName,
      packagePath,
      version,
      status: artifact.status,
      tagPrefix,
      releaseWorkflow,
      releaseEnvironment,
      releasePlatforms: platforms,
      requiredFiles,
      externalRequirements,
    };
  });
  return {
    schemaVersion: manifestSchema,
    repository: manifest.repository,
    permanentGates,
    forbiddenTemporaryPaths,
    artifacts,
  };
}

function validateReleaseManifest(value) {
  const manifest = exactRecord(
    value,
    ["schemaVersion", "artifacts"],
    "release manifest",
  );
  if (manifest.schemaVersion !== "lhic-release-manifest-v1") {
    throw new Error("Release manifest schemaVersion is unsupported.");
  }
  if (!Array.isArray(manifest.artifacts)) {
    throw new Error("Release manifest artifacts must be an array.");
  }
  return {
    schemaVersion: manifest.schemaVersion,
    artifacts: manifest.artifacts.map((entry, index) => {
      const artifact = exactRecord(
        entry,
        ["name", "packagePath", "version", "status"],
        `release artifact ${index}`,
      );
      return {
        name: boundedPackageName(
          artifact.name,
          `release artifact ${index} name`,
        ),
        packagePath: relativePath(
          artifact.packagePath,
          `release artifact ${index} packagePath`,
        ),
        version: semanticVersion(
          artifact.version,
          `release artifact ${index} version`,
        ),
        status: releaseStatuses.has(artifact.status)
          ? artifact.status
          : (() => {
              throw new Error(
                `Release artifact ${index} status is unsupported.`,
              );
            })(),
      };
    }),
  };
}

function validateNpmReleaseWorkflow(workflow, artifact) {
  for (const required of [
    'tags: ["cli-v*.*.*"]',
    "id-token: write",
    "environment: npm-release",
    "check-product-readiness.mjs",
    "--mode release",
    "--artifact cli",
    "--platform registry",
    "npm publish --workspace @pinyencheng/lhic --access public --provenance",
    "npm publish --workspace lhic --access public --provenance",
    "package:published-smoke",
    "package:published-alias-smoke",
  ]) {
    if (!workflow.includes(required)) {
      throw new Error(
        `${artifact.releaseWorkflow} is missing required npm release control: ${required}.`,
      );
    }
  }
}

function validateDesktopReleaseWorkflow(workflow, artifact) {
  for (const required of [
    'tags: ["desktop-v*.*.*"]',
    "environment: desktop-release",
    "contents: write",
    "check-product-readiness.mjs",
    "--mode release",
    "--artifact desktop",
    "--tag \"$GITHUB_REF_NAME\"",
    "--platform linux",
    "--platform macos",
    "--platform windows",
    "generate-sha256-manifest.mjs",
    "Get-AuthenticodeSignature",
    "LHIC_REQUIRE_NOTARIZATION=true",
    "gh release create",
  ]) {
    if (!workflow.includes(required)) {
      throw new Error(
        `${artifact.releaseWorkflow} is missing required desktop release control: ${required}.`,
      );
    }
  }
}

async function readJson(root, path, name) {
  const text = await readNormalTextFile(root, path);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

async function readNormalTextFile(root, path) {
  const absolutePath = safeRepositoryPath(root, path);
  const stat = await lstat(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${path} must be a normal file.`);
  }
  return readFile(absolutePath, "utf8");
}

async function assertNormalFile(root, path) {
  await readNormalTextFile(root, path);
}

async function assertNonemptyNormalFile(path, name) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1) {
    throw new Error(`${name} must reference a nonempty normal file.`);
  }
}

async function pathExists(root, path) {
  try {
    await lstat(safeRepositoryPath(root, path));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function safeRepositoryPath(root, path) {
  const normalized = relativePath(path, "repository path");
  const absolutePath = resolve(root, normalized);
  const pathRelative = relative(root, absolutePath);
  if (
    pathRelative === "" ||
    pathRelative === ".." ||
    pathRelative.startsWith(`..${sep}`) ||
    isAbsolute(pathRelative)
  ) {
    throw new Error(`Repository path escapes the root: ${path}.`);
  }
  return absolutePath;
}

function exactRecord(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const record = value;
  if (keys) {
    const actualKeys = Object.keys(record).sort();
    const expectedKeys = [...keys].sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index])
    ) {
      throw new Error(`${name} must contain exactly: ${keys.join(", ")}.`);
    }
  }
  return record;
}

function relativePath(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 240 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`${name} must be a bounded repository-relative path.`);
  }
  return value;
}

function relativePathList(value, name) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximumListItems
  ) {
    throw new Error(`${name} must be a bounded nonempty array.`);
  }
  const paths = value.map((entry, index) =>
    relativePath(entry, `${name}[${index}]`),
  );
  if (new Set(paths).size !== paths.length) {
    throw new Error(`${name} must contain unique paths.`);
  }
  return paths;
}

function stringList(value, name, allowed) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximumListItems
  ) {
    throw new Error(`${name} must be a bounded nonempty array.`);
  }
  const entries = value.map((entry, index) => {
    if (typeof entry !== "string" || !allowed.has(entry)) {
      throw new Error(`${name}[${index}] is unsupported.`);
    }
    return entry;
  });
  if (new Set(entries).size !== entries.length) {
    throw new Error(`${name} must contain unique values.`);
  }
  return entries;
}

function boundedStringList(value, name) {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximumListItems
  ) {
    throw new Error(`${name} must be a bounded nonempty array.`);
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      entry.length < 1 ||
      entry.length > 300 ||
      /[\r\n\0]/u.test(entry)
    ) {
      throw new Error(`${name}[${index}] must be bounded text.`);
    }
    return entry;
  });
}

function boundedIdentifier(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 80 ||
    !/^[A-Za-z0-9._@/-]+$/u.test(value)
  ) {
    throw new Error(`${name} must be a bounded identifier.`);
  }
  return value;
}

function boundedPackageName(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 214 ||
    !/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(
      value,
    )
  ) {
    throw new Error(`${name} must be an npm-style package name.`);
  }
  return value;
}

function semanticVersion(value, name) {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)
  ) {
    throw new Error(`${name} must be an exact X.Y.Z version.`);
  }
  return value;
}

function requireEnvironmentValue(environment, name) {
  if (!environment[name]) {
    throw new Error(`Release environment is missing ${name}.`);
  }
}

async function main() {
  const options = parseProductReadinessArguments(process.argv.slice(2));
  const report =
    options.mode === "candidate"
      ? await validateCandidateRepository({
          manifestPath: options.manifestPath,
        })
      : await validateReleaseEnvironment({
          manifestPath: options.manifestPath,
          artifactId: options.artifact,
          tag: options.tag,
          platform: options.platform,
        });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Product readiness failed.",
    );
    process.exitCode = 1;
  });
}
