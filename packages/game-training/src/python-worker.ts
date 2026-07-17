import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { GameCoreId } from "./types.js";

const execFileAsync = promisify(execFile);

export interface PythonEnvironmentReport {
  python: string;
  ready: boolean;
  packages: Record<string, boolean>;
  platform: string;
  detail?: string;
}

export interface PythonTrainingRequest {
  command: "fit" | "smoke";
  core: GameCoreId;
  datasetPath?: string;
  artifactDirectory?: string;
  profileDigest?: string;
  actionCodec?: string;
  preprocessingVersion?: string;
  frameWidth?: number;
  frameHeight?: number;
  frameHistory?: number;
  epochs?: number;
}

export interface PythonTrainingResult {
  core: GameCoreId;
  weightsFile?: string;
  weightsSha256?: string;
  behaviorCloningLoss: number;
  ppoReward: number;
  sampleCount: number;
}

export interface PythonPrediction {
  movement: string[];
  fire: boolean;
  aim?: { x: number; y: number };
  look?: { deltaX: number; deltaY: number };
}

export interface PythonDesktopResult {
  activeKeys?: string[];
  primaryDown?: boolean;
  frameFile?: string;
  supported?: boolean;
  detail?: string;
}

export function gameTrainingWorkerPath(): string {
  return fileURLToPath(new URL("../python/worker.py", import.meta.url));
}

export function gameTrainingRequirementsPath(): string {
  return fileURLToPath(new URL("../requirements.txt", import.meta.url));
}

export function gameTrainingPythonPath(environmentRoot: string): string {
  return process.platform === "win32"
    ? join(environmentRoot, "Scripts", "python.exe")
    : join(environmentRoot, "bin", "python");
}

export async function setupGameTrainingEnvironment(options: {
  environmentRoot: string;
  python?: string;
}): Promise<PythonEnvironmentReport> {
  const environmentRoot = resolve(options.environmentRoot);
  const python = options.python ?? "python3";
  await mkdir(dirname(environmentRoot), { recursive: true });
  const environmentPython = gameTrainingPythonPath(environmentRoot);
  const exists = await access(environmentPython).then(
    () => true,
    () => false,
  );
  if (!exists) {
    await execFileAsync(python, ["-m", "venv", environmentRoot], {
      maxBuffer: 1_024 * 1_024,
    });
  }
  await execFileAsync(
    environmentPython,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--requirement",
      gameTrainingRequirementsPath(),
    ],
    { maxBuffer: 1_024 * 1_024 },
  );
  return inspectGameTrainingEnvironment(environmentPython);
}

export async function inspectGameTrainingEnvironment(
  python = "python3",
): Promise<PythonEnvironmentReport> {
  const result = await runPythonWorker<{ report: PythonEnvironmentReport }>(
    python,
    { command: "doctor" },
  );
  return result.report;
}

export async function runPythonTraining(
  python: string,
  request: PythonTrainingRequest,
): Promise<PythonTrainingResult> {
  return runPythonWorker<PythonTrainingResult>(python, request);
}

export async function runPythonPrediction(
  python: string,
  request: {
    core: GameCoreId;
    weightsFile: string;
    frameFiles: string[];
  },
): Promise<PythonPrediction> {
  const result = await runPythonWorker<{ action: PythonPrediction }>(python, {
    command: "predict",
    ...request,
  });
  return result.action;
}

export async function runPythonDesktopWorker(
  python: string,
  request: Record<string, unknown>,
): Promise<PythonDesktopResult> {
  return runPythonWorker<PythonDesktopResult>(python, request);
}

async function runPythonWorker<T>(python: string, request: object): Promise<T> {
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString(
    "base64url",
  );
  try {
    const { stdout } = await execFileAsync(
      python,
      [gameTrainingWorkerPath(), "--request", encoded],
      { maxBuffer: 8 * 1_024 * 1_024 },
    );
    return JSON.parse(stdout) as T;
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    throw new Error(
      detail
        ? `Game-training Python worker failed: ${detail}`
        : "Game-training Python worker failed.",
    );
  }
}
