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

export function spawnProcess(
  executable: string,
  argumentsList: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() },
): SpawnedProcess {
  const child = spawn(executable, [...argumentsList], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return {
    child,
    completed: new Promise<ProcessResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr });
      });
    }),
  };
}
