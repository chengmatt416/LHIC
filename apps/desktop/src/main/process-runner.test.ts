import { describe, expect, it } from "vitest";

import { spawnProcess } from "./process-runner.js";

describe("spawnProcess", () => {
  it("bounds captured output and terminates a noisy process", async () => {
    const spawned = spawnProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1000000))"],
      { cwd: process.cwd(), maxOutputBytes: 128 },
    );

    const result = await spawned.completed;
    expect(result.exitCode).not.toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(128);
    expect(result.stderr).toContain("output exceeded");
  });

  it("terminates a provider process when its signal is aborted", async () => {
    const cancellation = new AbortController();
    const spawned = spawnProcess(
      process.execPath,
      ["-e", "setTimeout(() => undefined, 10000)"],
      { cwd: process.cwd(), signal: cancellation.signal },
    );

    cancellation.abort();
    const result = await spawned.completed;
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cancelled");
  });
});
