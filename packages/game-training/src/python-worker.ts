import { execFile, spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

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
  modelType?: string | undefined;
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

export interface PythonPolicySession {
  predict(frameFiles: string[]): Promise<PythonPrediction>;
  close(): Promise<void>;
}

export interface PythonDesktopRecordingSession {
  capture(frameFile: string): Promise<void>;
  readInput(): Promise<PythonDesktopInput>;
  close(): Promise<void>;
}

export interface PythonDesktopInput {
  heldKeys: string[];
  primaryDown: boolean;
  pointerX?: number;
  pointerY?: number;
  pointerDeltaX?: number;
  pointerDeltaY?: number;
}

export function gameTrainingWorkerPath(): string {
  return runtimeAssetPath(
    fileURLToPath(new URL("../python/worker.py", import.meta.url)),
  );
}

export function gameTrainingRequirementsPath(): string {
  return runtimeAssetPath(
    fileURLToPath(new URL("../requirements.txt", import.meta.url)),
  );
}

/** External Python processes cannot read Electron's virtual ASAR filesystem. */
export function runtimeAssetPath(value: string): string {
  return value.replace(/([\\/])app\.asar([\\/])/u, "$1app.asar.unpacked$2");
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

export async function startPythonPolicySession(
  python: string,
  request: { core: GameCoreId; weightsFile: string; modelType?: string | undefined },
): Promise<PythonPolicySession> {
  const child = spawn(python, [gameTrainingWorkerPath(), "--serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const iterator = lines[Symbol.asyncIterator]();
  let closed = false;
  let workerError: Error | undefined;
  child.on("error", (error) => {
    workerError = error;
  });

  const send = async (
    message: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> => {
    if (closed || child.killed || child.exitCode !== null || workerError) {
      throw new Error("Game-training policy worker is not running.");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
    const next = await nextPolicyResponse(iterator, timeoutMs);
    if (next.done) {
      const detail = stderr.trim();
      throw new Error(
        detail
          ? `Game-training policy worker stopped: ${detail}`
          : "Game-training policy worker stopped unexpectedly.",
      );
    }
    const response = JSON.parse(next.value) as Record<string, unknown>;
    if (typeof response.error === "string") {
      throw new Error(`Game-training policy worker failed: ${response.error}`);
    }
    return response;
  };

  try {
    const loaded = await send({ command: "load-policy", ...request });
    if (loaded.ready !== true || loaded.core !== request.core) {
      throw new Error(
        "Game-training policy worker did not load the requested core.",
      );
    }
  } catch (error) {
    closed = true;
    child.kill();
    lines.close();
    throw error;
  }

  return {
    async predict(frameFiles: string[]): Promise<PythonPrediction> {
      const response = await send({
        command: "predict",
        core: request.core,
        frameFiles,
      });
      const action = response.action;
      if (!action || typeof action !== "object") {
        throw new Error(
          "Game-training policy worker returned an invalid action.",
        );
      }
      return action as PythonPrediction;
    },
    async close(): Promise<void> {
      if (closed) return;
      try {
        await send({ command: "close" }, 1_000);
      } catch {
        child.kill();
      } finally {
        closed = true;
        lines.close();
      }
    },
  };
}

export async function startPythonDesktopRecordingSession(
  python: string,
  request: {
    allowedKeys: string[];
    captureRegion: { x: number; y: number; width: number; height: number };
  },
): Promise<PythonDesktopRecordingSession> {
  const child = spawn(python, [gameTrainingWorkerPath(), "--desktop-serve"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const iterator = lines[Symbol.asyncIterator]();
  let stderr = "";
  let workerError: Error | undefined;
  let closed = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    workerError = error;
  });

  const send = async (
    message: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown>> => {
    if (closed || child.killed || child.exitCode !== null || workerError) {
      throw new Error("Game-training desktop recorder is not running.");
    }
    await new Promise<void>((resolveWrite, rejectWrite) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) rejectWrite(error);
        else resolveWrite();
      });
    });
    const next = await nextPolicyResponse(iterator, timeoutMs);
    if (next.done) {
      const detail = stderr.trim();
      throw new Error(
        detail
          ? `Game-training desktop recorder stopped: ${detail}`
          : "Game-training desktop recorder stopped unexpectedly.",
      );
    }
    const response = JSON.parse(next.value) as Record<string, unknown>;
    if (typeof response.error === "string") {
      throw new Error(
        `Game-training desktop recorder failed: ${response.error}`,
      );
    }
    return response;
  };

  try {
    const started = await send({ command: "start-record", ...request });
    if (started.ready !== true) {
      throw new Error("Game-training desktop recorder did not start.");
    }
  } catch (error) {
    closed = true;
    child.kill();
    lines.close();
    throw error;
  }

  return {
    async capture(frameFile: string): Promise<void> {
      const response = await send({ command: "capture", frameFile });
      if (response.frameFile !== frameFile) {
        throw new Error(
          "Game-training desktop recorder captured an invalid frame.",
        );
      }
    },
    async readInput(): Promise<PythonDesktopInput> {
      const response = await send({ command: "read-input" });
      const input = response.input;
      if (
        !input ||
        typeof input !== "object" ||
        !Array.isArray((input as Partial<PythonDesktopInput>).heldKeys) ||
        !(input as Partial<PythonDesktopInput>).heldKeys?.every(
          (key) => typeof key === "string",
        ) ||
        typeof (input as Partial<PythonDesktopInput>).primaryDown !== "boolean"
      ) {
        throw new Error(
          "Game-training desktop recorder returned invalid input.",
        );
      }
      return input as PythonDesktopInput;
    },
    async close(): Promise<void> {
      if (closed) return;
      try {
        await send({ command: "close" }, 1_000);
      } catch {
        child.kill();
      } finally {
        closed = true;
        lines.close();
      }
    },
  };
}

async function nextPolicyResponse(
  iterator: AsyncIterator<string>,
  timeoutMs: number,
): Promise<IteratorResult<string>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Game-training policy worker timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
