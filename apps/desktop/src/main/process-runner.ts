import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnedProcess {
  child: ChildProcess;
  completed: Promise<ProcessResult>;
}

export interface SpawnProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export function spawnProcess(
  executable: string,
  argumentsList: readonly string[],
  options: SpawnProcessOptions = { cwd: process.cwd() },
): SpawnedProcess {
  const child = spawn(executable, [...argumentsList], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576;
  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let stoppedForOutputLimit = false;
  let stoppedForCancellation = options.signal?.aborted ?? false;
  let closed = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    child.kill();
    forceKillTimer ??= setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, 250);
    forceKillTimer.unref();
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  const appendOutput = (target: "stdout" | "stderr", chunk: string) => {
    if (stoppedForOutputLimit) return;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    const remaining = maxOutputBytes - outputBytes;
    if (remaining <= 0 || chunkBytes > remaining) {
      stoppedForOutputLimit = true;
      terminate();
      return;
    }
    outputBytes += chunkBytes;
    if (target === "stdout") stdout += chunk;
    else stderr += chunk;
  };
  child.stdout?.on("data", (chunk: string) => appendOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: string) => appendOutput("stderr", chunk));
  const abort = () => {
    stoppedForCancellation = true;
    terminate();
  };
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }
  return {
    child,
    completed: new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => {
        closed = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (options.signal) {
          options.signal.removeEventListener("abort", abort);
        }
        resolve({
          exitCode: exitCode ?? 1,
          stdout,
          stderr:
            stoppedForCancellation && !stderr
              ? "Process cancelled."
              : stoppedForOutputLimit && !stderr
                ? "Process output exceeded the configured limit."
                : stderr,
        });
      });
    }),
  };
}
