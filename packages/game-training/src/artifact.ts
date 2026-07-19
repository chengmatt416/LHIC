import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  GameCoreId,
  GameFrameSpec,
  GamePolicyArtifact,
  GameTargetProfile,
} from "./types.js";

export async function writeGamePolicyArtifact(
  filePath: string,
  artifact: GamePolicyArtifact,
): Promise<void> {
  validateGamePolicyArtifact(artifact);
  const resolved = resolve(filePath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export async function readGamePolicyArtifact(
  filePath: string,
): Promise<GamePolicyArtifact> {
  const parsed = JSON.parse(
    await readFile(resolve(filePath), "utf8"),
  ) as unknown;
  validateGamePolicyArtifact(parsed);
  return parsed;
}

export function validateGamePolicyArtifact(
  value: unknown,
): asserts value is GamePolicyArtifact {
  if (!value || typeof value !== "object")
    throw new Error("Game policy artifact is invalid.");
  const artifact = value as Partial<GamePolicyArtifact>;
  if (
    artifact.schemaVersion !== "game-policy-v1" ||
    (artifact.core !== "2d" && artifact.core !== "3d") ||
    typeof artifact.profileId !== "string" ||
    !artifact.profileId ||
    typeof artifact.profileDigest !== "string" ||
    !artifact.profileDigest ||
    typeof artifact.preprocessingVersion !== "string" ||
    !artifact.preprocessingVersion ||
    !isFrameSpec(artifact.frameSpec) ||
    typeof artifact.actionCodec !== "string" ||
    !artifact.actionCodec ||
    !isSafeWeightsFile(artifact.weightsFile) ||
    !/^[a-f0-9]{64}$/.test(artifact.weightsSha256 ?? "") ||
    (artifact.modelType !== undefined &&
      typeof artifact.modelType !== "string") ||
    artifact.training?.algorithm !== "behavior-cloning-v1" ||
    !Number.isSafeInteger(artifact.training.seed) ||
    !/^[a-f0-9]{64}$/.test(artifact.training.datasetSha256 ?? "") ||
    !Number.isFinite(artifact.training.validationSplit) ||
    artifact.training.validationSplit! <= 0 ||
    artifact.training.validationSplit! >= 0.5 ||
    !Number.isSafeInteger(artifact.training.trainingSampleCount) ||
    artifact.training.trainingSampleCount! < 1 ||
    !Number.isSafeInteger(artifact.training.validationSampleCount) ||
    artifact.training.validationSampleCount! < 1 ||
    !artifact.metrics ||
    !Number.isFinite(artifact.metrics.behaviorCloningLoss) ||
    !Number.isFinite(artifact.metrics.datasetReward) ||
    !Number.isFinite(artifact.metrics.validationLoss) ||
    !Number.isFinite(artifact.metrics.validationActionAccuracy) ||
    artifact.metrics.validationActionAccuracy < 0 ||
    artifact.metrics.validationActionAccuracy > 1 ||
    !Number.isFinite(Date.parse(artifact.createdAt ?? ""))
  ) {
    throw new Error("Game policy artifact is invalid.");
  }
}

export function assertArtifactCompatible(
  artifact: GamePolicyArtifact,
  core: GameCoreId,
  profile: GameTargetProfile,
  profileDigest: string,
  expected?: {
    actionCodec: string;
    preprocessingVersion: string;
    frameSpec: GameFrameSpec;
  },
): void {
  validateGamePolicyArtifact(artifact);
  if (artifact.core !== core || profile.core !== core) {
    throw new Error(
      "Game policy artifact belongs to a different training core.",
    );
  }
  if (
    artifact.profileId !== profile.id ||
    artifact.profileDigest !== profileDigest
  ) {
    throw new Error("Game policy artifact does not match this target profile.");
  }
  if (
    expected &&
    (artifact.actionCodec !== expected.actionCodec ||
      artifact.preprocessingVersion !== expected.preprocessingVersion ||
      artifact.frameSpec.width !== expected.frameSpec.width ||
      artifact.frameSpec.height !== expected.frameSpec.height ||
      artifact.frameSpec.channels !== expected.frameSpec.channels ||
      artifact.frameSpec.history !== expected.frameSpec.history)
  ) {
    throw new Error(
      "Game policy artifact uses an incompatible action or preprocessing codec.",
    );
  }
}

export async function assertGamePolicyWeights(
  artifact: GamePolicyArtifact,
  weightsFile: string,
): Promise<void> {
  const contents = await readFile(resolve(weightsFile));
  if (sha256(contents) !== artifact.weightsSha256) {
    throw new Error(
      "Game-policy weights do not match their artifact manifest.",
    );
  }
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isFrameSpec(value: unknown): value is GameFrameSpec {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<GameFrameSpec>;
  return (
    Number.isSafeInteger(frame.width) &&
    Number.isSafeInteger(frame.height) &&
    frame.width! > 0 &&
    frame.height! > 0 &&
    frame.channels === 3 &&
    Number.isSafeInteger(frame.history) &&
    frame.history! > 0
  );
}

function isSafeWeightsFile(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    value !== "." &&
    value !== ".."
  );
}
