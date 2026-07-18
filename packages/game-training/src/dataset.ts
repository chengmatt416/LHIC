import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, win32 } from "node:path";

import type { GameDatasetManifest, GameEpisodeSample } from "./types.js";

export async function writeGameDatasetManifest(
  filePath: string,
  manifest: GameDatasetManifest,
): Promise<void> {
  validateGameDatasetManifest(manifest);
  const resolved = resolve(filePath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function readGameDatasetManifest(
  filePath: string,
): Promise<GameDatasetManifest> {
  const parsed = JSON.parse(
    await readFile(resolve(filePath), "utf8"),
  ) as unknown;
  if (!isGameDatasetManifest(parsed)) {
    throw new Error("Game dataset manifest is invalid.");
  }
  return parsed;
}

export function validateGameDatasetManifest(
  manifest: GameDatasetManifest,
): void {
  if (!isGameDatasetManifest(manifest)) {
    throw new Error("Game dataset manifest is invalid.");
  }
  let previousTimestamp = -1;
  for (const sample of manifest.samples) {
    if (sample.timestampMs < previousTimestamp) {
      throw new Error("Game dataset samples must be chronological.");
    }
    previousTimestamp = sample.timestampMs;
  }
}

export function gameDatasetDigest(manifest: GameDatasetManifest): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export function createGameEpisodeSample(
  sample: GameEpisodeSample,
): GameEpisodeSample {
  if (!isSafeRelativeFramePath(sample.frame)) {
    throw new Error("Game frames must use a safe relative file path.");
  }
  return sample;
}

function isGameDatasetManifest(value: unknown): value is GameDatasetManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GameDatasetManifest>;
  return (
    candidate.schemaVersion === "game-dataset-v1" &&
    (candidate.core === "2d" || candidate.core === "3d") &&
    typeof candidate.profileId === "string" &&
    candidate.profileId.length > 0 &&
    typeof candidate.profileDigest === "string" &&
    candidate.profileDigest.length > 0 &&
    typeof candidate.preprocessingVersion === "string" &&
    candidate.preprocessingVersion.length > 0 &&
    typeof candidate.actionCodec === "string" &&
    candidate.actionCodec.length > 0 &&
    Number.isSafeInteger(candidate.seed) &&
    (candidate.surface === "browser" || candidate.surface === "desktop") &&
    Number.isFinite(Date.parse(candidate.createdAt ?? "")) &&
    Array.isArray(candidate.samples) &&
    candidate.samples.every(isGameEpisodeSample)
  );
}

function isGameEpisodeSample(value: unknown): value is GameEpisodeSample {
  if (!value || typeof value !== "object") return false;
  const sample = value as Partial<GameEpisodeSample>;
  return (
    Number.isSafeInteger(sample.timestampMs) &&
    sample.timestampMs! >= 0 &&
    isSafeRelativeFramePath(sample.frame) &&
    Array.isArray(sample.input?.heldKeys) &&
    typeof sample.input?.primaryDown === "boolean" &&
    typeof sample.telemetry?.terminal === "boolean" &&
    hasFiniteOptionalNumber(sample.telemetry?.score) &&
    hasFiniteOptionalNumber(sample.telemetry?.health)
  );
}

function hasFiniteOptionalNumber(value: unknown): boolean {
  return (
    value === undefined || (typeof value === "number" && Number.isFinite(value))
  );
}

function isSafeRelativeFramePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    return false;
  }
  return !value.replaceAll("\\", "/").split("/").includes("..");
}
