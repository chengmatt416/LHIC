import { describe, expect, it } from "vitest";

import {
  checkExternalBenchmarkReadiness,
  type CommandRunner,
} from "./external-benchmark-readiness.js";

describe("checkExternalBenchmarkReadiness", () => {
  it("reports a ready WorkArena environment without exposing the token", () => {
    const runner: CommandRunner = (command, argumentsList) => {
      if (command === "python3" && argumentsList[0] === "--version") {
        return { status: 0, stdout: "Python 3.12.3", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    };
    const report = checkExternalBenchmarkReadiness(
      "workarena",
      { HUGGING_FACE_HUB_TOKEN: "test-token" },
      runner,
    );

    expect(report).toMatchObject({
      benchmark: "workarena",
      passed: true,
      submissionAllowed: false,
    });
    expect(JSON.stringify(report)).not.toContain("test-token");
  });

  it("reports unsupported Python and an unavailable WebArena daemon", () => {
    const runner: CommandRunner = (command, argumentsList) => {
      if (command === "python3" && argumentsList[0] === "--version") {
        return { status: 0, stdout: "Python 3.14.0", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "unavailable" };
    };
    const report = checkExternalBenchmarkReadiness("webarena", {}, runner);

    expect(report.passed).toBe(false);
    expect(report.checks).toContainEqual({
      name: "python-version",
      passed: false,
      detail: "AgentLab requires Python 3.11 or 3.12.",
    });
    expect(report.checks).toContainEqual({
      name: "docker-daemon",
      passed: false,
      detail:
        "Docker daemon is not reachable for self-hosted WebArena infrastructure.",
    });
  });
});
