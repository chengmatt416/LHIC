import { spawnSync } from "node:child_process";

export const externalBenchmarkTargets = ["workarena", "webarena"] as const;

export type ExternalBenchmarkTarget = (typeof externalBenchmarkTargets)[number];
export type EnvironmentSource = Record<string, string | undefined>;

export interface ReadinessCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ExternalBenchmarkReadinessReport {
  benchmark: ExternalBenchmarkTarget;
  passed: boolean;
  checks: ReadinessCheck[];
  submissionAllowed: false;
  conclusion: string;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type CommandRunner = (
  command: string,
  argumentsList: string[],
) => CommandResult;

export function checkExternalBenchmarkReadiness(
  target: ExternalBenchmarkTarget,
  environment: EnvironmentSource = process.env,
  runCommand: CommandRunner = runCommandSync,
): ExternalBenchmarkReadinessReport {
  const checks = [pythonVersionCheck(runCommand), agentLabCheck(runCommand)];
  if (target === "workarena") {
    checks.push(workArenaAccessCheck(environment));
  } else {
    checks.push(dockerDaemonCheck(runCommand));
  }
  const passed = checks.every((check) => check.passed);
  return {
    benchmark: target,
    passed,
    checks,
    submissionAllowed: false,
    conclusion: passed
      ? "Environment readiness passed, but an unmodified full-suite run, comparator analysis, published artifacts, independent reproduction, and authorised human submission are still required."
      : "Benchmark environment is not ready. Resolve every failed check before attempting a study; no benchmark submission is allowed.",
  };
}

export function parseExternalBenchmarkTarget(
  value: string | undefined,
): ExternalBenchmarkTarget | undefined {
  return externalBenchmarkTargets.includes(value as ExternalBenchmarkTarget)
    ? (value as ExternalBenchmarkTarget)
    : undefined;
}

function pythonVersionCheck(runCommand: CommandRunner): ReadinessCheck {
  const result = runCommand("python3", ["--version"]);
  const match = `${result.stdout}\n${result.stderr}`.match(/Python 3\.(\d+)/);
  const minorVersion = match?.[1] ? Number(match[1]) : undefined;
  const supported = minorVersion === 11 || minorVersion === 12;
  return {
    name: "python-version",
    passed: supported,
    detail: supported
      ? `Python 3.${minorVersion} is supported by AgentLab.`
      : "AgentLab requires Python 3.11 or 3.12.",
  };
}

function agentLabCheck(runCommand: CommandRunner): ReadinessCheck {
  const result = runCommand("python3", ["-c", "import agentlab"]);
  return {
    name: "agentlab",
    passed: result.status === 0,
    detail:
      result.status === 0
        ? "AgentLab is importable from python3."
        : "AgentLab is not importable from python3.",
  };
}

function workArenaAccessCheck(environment: EnvironmentSource): ReadinessCheck {
  const configured = Boolean(environment.HUGGING_FACE_HUB_TOKEN?.trim());
  return {
    name: "workarena-access",
    passed: configured,
    detail: configured
      ? "A Hugging Face access token is configured; gated WorkArena access still requires prior approval."
      : "WorkArena requires approved gated Hugging Face access configured outside this process.",
  };
}

function dockerDaemonCheck(runCommand: CommandRunner): ReadinessCheck {
  const result = runCommand("docker", [
    "info",
    "--format",
    "{{.ServerVersion}}",
  ]);
  return {
    name: "docker-daemon",
    passed: result.status === 0,
    detail:
      result.status === 0
        ? "Docker daemon is reachable for self-hosted WebArena infrastructure."
        : "Docker daemon is not reachable for self-hosted WebArena infrastructure.",
  };
}

function runCommandSync(
  command: string,
  argumentsList: string[],
): CommandResult {
  const result = spawnSync(command, argumentsList, {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
}
