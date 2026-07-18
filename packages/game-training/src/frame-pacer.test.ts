import { describe, expect, it } from "vitest";

import { GameFramePacer } from "./frame-pacer.js";

describe("GameFramePacer", () => {
  it("waits only for the unspent part of the target frame", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const pacer = new GameFramePacer(20, {
      now: () => now,
      sleep: async (durationMs) => {
        sleeps.push(durationMs);
        now += durationMs;
      },
    });

    const frameStartedAt = pacer.startFrame();
    now += 18;
    await pacer.completeFrame(frameStartedAt);

    expect(sleeps).toEqual([32]);
    expect(pacer.metrics()).toMatchObject({
      frameCount: 1,
      processingP50Ms: 18,
      frameP95Ms: 50,
      missedDeadlineCount: 0,
      observedFrameRateHz: 20,
    });
  });

  it("does not wait or hide a deadline miss when work exceeds the frame", async () => {
    let now = 0;
    const pacer = new GameFramePacer(20, {
      now: () => now,
      sleep: async () => {
        throw new Error("a missed frame must not schedule extra sleep");
      },
    });

    const frameStartedAt = pacer.startFrame();
    now += 73;
    await expect(pacer.completeFrame(frameStartedAt)).resolves.toMatchObject({
      processingMs: 73,
      sleepMs: 0,
      frameMs: 73,
      missedDeadline: true,
    });
    expect(pacer.metrics()).toMatchObject({
      processingP95Ms: 73,
      missedDeadlineCount: 1,
      observedFrameRateHz: 13.699,
    });
  });

  it("rejects an unsafe control frequency", () => {
    expect(() => new GameFramePacer(0)).toThrow("between 1 and 120 Hz");
    expect(() => new GameFramePacer(121)).toThrow("between 1 and 120 Hz");
  });
});
