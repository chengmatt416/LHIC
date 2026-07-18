import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { deflateRawSync } from "node:zlib";

import { readGamePolicyArtifact } from "./artifact.js";
import type { GamePolicyArtifact } from "./types.js";

export interface GamePolicyPackageManifest {
  schemaVersion: "game-policy-package-v1";
  packageId: string;
  core: GamePolicyArtifact["core"];
  profileId: string;
  createdAt: string;
  actionMapping: {
    codec: string;
    preprocessingVersion: string;
    frameSpec: GamePolicyArtifact["frameSpec"];
  };
  files: {
    artifact: { name: "artifact.json"; sha256: string };
    weights: { name: string; sha256: string };
    evaluationReport?: { name: "evaluation-report.json"; sha256: string };
  };
}

export interface CreatedGamePolicyPackage {
  packageDirectory: string;
  manifestPath: string;
  artifactPath: string;
  weightsPath: string;
  reportPath?: string;
  bundlePath: string;
  bundleSha256: string;
  manifest: GamePolicyPackageManifest;
}

export interface VerifiedGamePolicyPackage {
  packageDirectory: string;
  manifestPath: string;
  artifactPath: string;
  weightsPath: string;
  reportPath?: string;
  bundlePath: string;
  bundleSha256: string;
  manifestSha256: string;
  manifest: GamePolicyPackageManifest;
}

/**
 * Creates a reviewable policy-only bundle. Datasets, frames, mouse and keyboard
 * recordings are deliberately neither read nor copied into the package.
 */
export async function createGamePolicyPackage(input: {
  artifactPath: string;
  destinationDirectory: string;
  evaluationReportPath?: string;
}): Promise<CreatedGamePolicyPackage> {
  const artifactPath = resolve(input.artifactPath);
  const artifact = await readGamePolicyArtifact(artifactPath);
  const sourceDirectory = dirname(artifactPath);
  const sourceWeightsPath = resolve(sourceDirectory, artifact.weightsFile);
  assertContained(sourceDirectory, sourceWeightsPath, "Policy weights");
  if (basename(artifact.weightsFile) !== artifact.weightsFile) {
    throw new Error(
      "Policy weights must be a single file beside the artifact.",
    );
  }
  await stat(sourceWeightsPath);

  const destinationDirectory = resolve(input.destinationDirectory);
  if (destinationDirectory === sourceDirectory) {
    throw new Error(
      "Policy package destination must differ from the artifact directory.",
    );
  }
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const manifestPath = resolve(destinationDirectory, "policy-package.json");
  try {
    await stat(manifestPath);
    throw new Error(
      "Policy package destination already contains a package manifest.",
    );
  } catch (error) {
    if (!(error as NodeJS.ErrnoException).code) throw error;
  }

  const artifactContents = await readFile(artifactPath);
  const weightsContents = await readFile(sourceWeightsPath);
  const artifactOutputPath = resolve(destinationDirectory, "artifact.json");
  const weightsOutputPath = resolve(destinationDirectory, artifact.weightsFile);
  assertContained(destinationDirectory, artifactOutputPath, "Policy artifact");
  assertContained(destinationDirectory, weightsOutputPath, "Policy weights");
  await copyFile(artifactPath, artifactOutputPath);
  await copyFile(sourceWeightsPath, weightsOutputPath);

  let reportPath: string | undefined;
  let evaluationReport:
    GamePolicyPackageManifest["files"]["evaluationReport"] | undefined;
  if (input.evaluationReportPath) {
    const reportContents = await readSafeEvaluationReport(
      input.evaluationReportPath,
    );
    reportPath = resolve(destinationDirectory, "evaluation-report.json");
    await writeFile(reportPath, reportContents, {
      encoding: "utf8",
      mode: 0o600,
    });
    evaluationReport = {
      name: "evaluation-report.json",
      sha256: digest(reportContents),
    };
  }

  const createdAt = new Date().toISOString();
  const manifestWithoutId = {
    core: artifact.core,
    profileId: artifact.profileId,
    createdAt,
    artifactSha256: digest(artifactContents),
    weightsSha256: digest(weightsContents),
    actionCodec: artifact.actionCodec,
    preprocessingVersion: artifact.preprocessingVersion,
    ...(evaluationReport
      ? { evaluationReportSha256: evaluationReport.sha256 }
      : {}),
  };
  const manifest: GamePolicyPackageManifest = {
    schemaVersion: "game-policy-package-v1",
    packageId: digest(Buffer.from(JSON.stringify(manifestWithoutId))),
    core: artifact.core,
    profileId: artifact.profileId,
    createdAt,
    actionMapping: {
      codec: artifact.actionCodec,
      preprocessingVersion: artifact.preprocessingVersion,
      frameSpec: { ...artifact.frameSpec },
    },
    files: {
      artifact: { name: "artifact.json", sha256: digest(artifactContents) },
      weights: {
        name: basename(artifact.weightsFile),
        sha256: digest(weightsContents),
      },
      ...(evaluationReport ? { evaluationReport } : {}),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const manifestContents = await readFile(manifestPath);
  const bundlePath = resolve(destinationDirectory, "policy-package.zip");
  const bundle = createZip([
    { name: "artifact.json", content: artifactContents },
    { name: artifact.weightsFile, content: weightsContents },
    ...(reportPath
      ? [
          {
            name: "evaluation-report.json",
            content: await readFile(reportPath),
          },
        ]
      : []),
    { name: "policy-package.json", content: manifestContents },
  ]);
  await writeFile(bundlePath, bundle, { mode: 0o600, flag: "wx" });
  return {
    packageDirectory: destinationDirectory,
    manifestPath,
    artifactPath: artifactOutputPath,
    weightsPath: weightsOutputPath,
    ...(reportPath ? { reportPath } : {}),
    bundlePath,
    bundleSha256: digest(bundle),
    manifest,
  };
}

/**
 * Revalidates a local review package immediately before its metadata is
 * submitted to the shared library. The bundle must be byte-for-byte the
 * deterministic policy-only archive produced by this module.
 */
export async function verifyGamePolicyPackage(input: {
  manifestPath: string;
  bundlePath: string;
}): Promise<VerifiedGamePolicyPackage> {
  const manifestPath = resolve(input.manifestPath);
  const packageDirectory = dirname(manifestPath);
  const bundlePath = resolve(input.bundlePath);
  assertContained(packageDirectory, bundlePath, "Policy bundle");
  if (basename(manifestPath) !== "policy-package.json") {
    throw new Error("Policy package manifest name is invalid.");
  }
  if (basename(bundlePath) !== "policy-package.zip") {
    throw new Error("Policy package bundle name is invalid.");
  }

  const manifestContents = await readFile(manifestPath);
  const manifest = parsePackageManifest(manifestContents);
  const artifactPath = resolve(packageDirectory, manifest.files.artifact.name);
  const weightsPath = resolve(packageDirectory, manifest.files.weights.name);
  assertContained(packageDirectory, artifactPath, "Policy artifact");
  assertContained(packageDirectory, weightsPath, "Policy weights");
  const artifactContents = await readFile(artifactPath);
  const weightsContents = await readFile(weightsPath);
  if (
    digest(artifactContents) !== manifest.files.artifact.sha256 ||
    digest(weightsContents) !== manifest.files.weights.sha256
  ) {
    throw new Error("Policy package file integrity verification failed.");
  }
  const artifact = await readGamePolicyArtifact(artifactPath);
  if (
    artifact.core !== manifest.core ||
    artifact.profileId !== manifest.profileId ||
    artifact.actionCodec !== manifest.actionMapping.codec ||
    artifact.preprocessingVersion !==
      manifest.actionMapping.preprocessingVersion ||
    JSON.stringify(artifact.frameSpec) !==
      JSON.stringify(manifest.actionMapping.frameSpec) ||
    artifact.weightsFile !== manifest.files.weights.name
  ) {
    throw new Error("Policy package manifest does not match its artifact.");
  }
  const expectedPackageId = digest(
    Buffer.from(
      JSON.stringify({
        core: manifest.core,
        profileId: manifest.profileId,
        createdAt: manifest.createdAt,
        artifactSha256: manifest.files.artifact.sha256,
        weightsSha256: manifest.files.weights.sha256,
        actionCodec: manifest.actionMapping.codec,
        preprocessingVersion: manifest.actionMapping.preprocessingVersion,
        ...(manifest.files.evaluationReport
          ? {
              evaluationReportSha256: manifest.files.evaluationReport.sha256,
            }
          : {}),
      }),
    ),
  );
  if (manifest.packageId !== expectedPackageId) {
    throw new Error("Policy package identifier verification failed.");
  }

  let reportPath: string | undefined;
  let reportContents: Buffer | undefined;
  if (manifest.files.evaluationReport) {
    reportPath = resolve(
      packageDirectory,
      manifest.files.evaluationReport.name,
    );
    assertContained(packageDirectory, reportPath, "Evaluation report");
    reportContents = await readSafeEvaluationReport(reportPath);
    if (digest(reportContents) !== manifest.files.evaluationReport.sha256) {
      throw new Error("Evaluation report integrity verification failed.");
    }
  }
  const expectedBundle = createZip([
    { name: manifest.files.artifact.name, content: artifactContents },
    { name: manifest.files.weights.name, content: weightsContents },
    ...(reportContents && manifest.files.evaluationReport
      ? [
          {
            name: manifest.files.evaluationReport.name,
            content: reportContents,
          },
        ]
      : []),
    { name: "policy-package.json", content: manifestContents },
  ]);
  const bundle = await readFile(bundlePath);
  if (!bundle.equals(expectedBundle)) {
    throw new Error(
      "Policy bundle contains unexpected data or differs from its manifest.",
    );
  }
  return {
    packageDirectory,
    manifestPath,
    artifactPath,
    weightsPath,
    ...(reportPath ? { reportPath } : {}),
    bundlePath,
    bundleSha256: digest(bundle),
    manifestSha256: digest(manifestContents),
    manifest,
  };
}

async function readSafeEvaluationReport(path: string): Promise<Buffer> {
  const resolved = resolve(path);
  const contents = await readFile(resolved);
  if (contents.byteLength > 1_000_000) {
    throw new Error("Evaluation reports are limited to 1 MB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new Error("Evaluation report must be valid JSON.");
  }
  assertSafeReport(value);
  return contents;
}

function parsePackageManifest(contents: Buffer): GamePolicyPackageManifest {
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    throw new Error("Policy package manifest must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Policy package manifest is invalid.");
  }
  const manifest = value as Record<string, unknown>;
  assertExactKeys(
    manifest,
    [
      "schemaVersion",
      "packageId",
      "core",
      "profileId",
      "createdAt",
      "actionMapping",
      "files",
    ],
    "Policy package manifest",
  );
  if (
    manifest.schemaVersion !== "game-policy-package-v1" ||
    !isSha256(manifest.packageId) ||
    (manifest.core !== "2d" && manifest.core !== "3d") ||
    !isLimitedString(manifest.profileId, 128) ||
    !isIsoDate(manifest.createdAt)
  ) {
    throw new Error("Policy package manifest is invalid.");
  }
  const actionMapping = requiredObject(
    manifest.actionMapping,
    "Action mapping",
  );
  assertExactKeys(
    actionMapping,
    ["codec", "preprocessingVersion", "frameSpec"],
    "Action mapping",
  );
  if (
    !isLimitedString(actionMapping.codec, 128) ||
    !isLimitedString(actionMapping.preprocessingVersion, 128) ||
    !actionMapping.frameSpec ||
    typeof actionMapping.frameSpec !== "object" ||
    Array.isArray(actionMapping.frameSpec) ||
    !isFrameSpec(actionMapping.frameSpec)
  ) {
    throw new Error("Policy package action mapping is invalid.");
  }
  const files = requiredObject(manifest.files, "Policy package files");
  assertExactKeys(
    files,
    ["artifact", "weights", "evaluationReport"],
    "Policy package files",
    true,
  );
  const artifact = parsePackageFile(
    files.artifact,
    "artifact.json",
    "artifact",
  );
  const weights = parsePackageFile(files.weights, undefined, "weights");
  if (
    weights.name !== basename(weights.name) ||
    weights.name === "artifact.json"
  ) {
    throw new Error("Policy package weights entry is invalid.");
  }
  const evaluationReport =
    files.evaluationReport === undefined
      ? undefined
      : parsePackageFile(
          files.evaluationReport,
          "evaluation-report.json",
          "evaluation report",
        );
  return {
    schemaVersion: "game-policy-package-v1",
    packageId: manifest.packageId,
    core: manifest.core,
    profileId: manifest.profileId,
    createdAt: new Date(manifest.createdAt).toISOString(),
    actionMapping: {
      codec: actionMapping.codec,
      preprocessingVersion: actionMapping.preprocessingVersion,
      frameSpec: actionMapping.frameSpec as GamePolicyArtifact["frameSpec"],
    },
    files: {
      artifact: { name: "artifact.json", sha256: artifact.sha256 },
      weights: { name: weights.name, sha256: weights.sha256 },
      ...(evaluationReport
        ? {
            evaluationReport: {
              name: "evaluation-report.json",
              sha256: evaluationReport.sha256,
            },
          }
        : {}),
    },
  };
}

function parsePackageFile(
  value: unknown,
  requiredName: string | undefined,
  label: string,
): { name: string; sha256: string } {
  const file = requiredObject(value, `Policy package ${label}`);
  assertExactKeys(file, ["name", "sha256"], `Policy package ${label}`);
  if (
    !isLimitedString(file.name, 255) ||
    (requiredName !== undefined && file.name !== requiredName) ||
    !isSha256(file.sha256)
  ) {
    throw new Error(`Policy package ${label} is invalid.`);
  }
  return { name: file.name, sha256: file.sha256 };
}

function requiredObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optionalFinalKey = false,
): void {
  const keys = Object.keys(value);
  const required = optionalFinalKey ? allowed.slice(0, -1) : allowed;
  if (
    !required.every((key) => key in value) ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new Error(`${label} contains unsupported data.`);
  }
}

function isLimitedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isFrameSpec(value: object): value is GamePolicyArtifact["frameSpec"] {
  const frameSpec = value as Record<string, unknown>;
  assertExactKeys(
    frameSpec,
    ["width", "height", "channels", "history"],
    "Policy package frame specification",
  );
  return [
    frameSpec.width,
    frameSpec.height,
    frameSpec.channels,
    frameSpec.history,
  ].every(
    (item) =>
      typeof item === "number" &&
      Number.isSafeInteger(item) &&
      item > 0 &&
      item <= 4_096,
  );
}

function assertSafeReport(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeReport(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(?:frames?|samples?|dataset(?:Path)?|trace(?:Path)?|raw(?:Data)?|inputEvents?|mouse|keyboard|recording)$/i.test(
        key,
      )
    ) {
      throw new Error(
        "Evaluation reports may not include raw gameplay recordings or dataset references.",
      );
    }
    assertSafeReport(item);
  }
}

function assertContained(root: string, path: string, label: string): void {
  const fromRoot = relative(resolve(root), resolve(path));
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(`${label} must remain beside the policy artifact.`);
  }
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createZip(
  entries: readonly { name: string; content: Uint8Array }[],
): Buffer {
  const localFiles: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const input = Buffer.from(entry.content);
    const compressed = deflateRawSync(input);
    const checksum = crc32(input);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(input.length, 22);
    local.writeUInt16LE(name.length, 26);
    localFiles.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(input.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralDirectory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centralDirectory);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(entries.length, 8);
  footer.writeUInt16LE(entries.length, 10);
  footer.writeUInt32LE(central.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...localFiles, central, footer]);
}

function crc32(input: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of input) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}
