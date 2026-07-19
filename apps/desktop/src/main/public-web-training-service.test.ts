import { describe, expect, it, vi } from "vitest";

import {
  PublicWebTrainingService,
  validatePublicWebTrainingRequest,
} from "./public-web-training-service.js";

describe("PublicWebTrainingService", () => {
  it("starts a verifier-backed local workflow without an LLM or MCP adapter", async () => {
    const run = vi.fn().mockResolvedValue({
      candidate: "slow-path-test",
      verifiedRunCount: 1,
      holdoutPassed: false,
      promoted: false,
      localOnly: true,
    });
    const service = new PublicWebTrainingService("/workspace", { run });
    const updates: string[] = [];
    service.subscribe((update) => updates.push(update.status));

    const job = await service.start({
      scenarioId: "wikipedia-search",
      query: "browser automation",
    });

    await vi.waitFor(() => {
      expect(service.status(job.id).status).toBe("completed");
    });
    expect(job.command).toEqual([
      "desktop",
      "skills",
      "train-public-web",
      "wikipedia-search",
    ]);
    expect(run).toHaveBeenCalledWith(
      job.id,
      { scenarioId: "wikipedia-search", query: "browser automation" },
      expect.any(AbortSignal),
    );
    expect(service.status(job.id).report).toMatchObject({ localOnly: true });
    expect(updates).toEqual(["running", "completed"]);
  });

  it("rejects unallowlisted scenarios and sensitive queries", () => {
    expect(() =>
      validatePublicWebTrainingRequest({
        scenarioId: "unknown",
        query: "browser automation",
      }),
    ).toThrow("unsupported");
    expect(() =>
      validatePublicWebTrainingRequest({
        scenarioId: "mdn-search",
        query: "sk_live_abcdefghijklmnop",
      }),
    ).toThrow("credentials or personal data");
  });

  it("cancels a running workflow through its abort signal", async () => {
    let signal: AbortSignal | undefined;
    const service = new PublicWebTrainingService("/workspace", {
      run: vi.fn(
        (_jobId, _input, activeSignal: AbortSignal) =>
          new Promise((_, reject) => {
            signal = activeSignal;
            activeSignal.addEventListener("abort", () =>
              reject(new Error("cancelled")),
            );
          }),
      ),
    });
    const job = await service.start({
      scenarioId: "mdn-search",
      query: "browser automation",
    });

    await service.cancel(job.id);
    expect(signal?.aborted).toBe(true);
    expect(service.status(job.id).status).toBe("cancelled");
  });

  it("never accepts an immediate Fast Path promotion request", () => {
    const validated = validatePublicWebTrainingRequest({
      scenarioId: "mdn-search",
      query: "browser automation",
    });
    expect(validated).toMatchObject({
      scenarioId: "mdn-search",
      query: "browser automation",
    });
    expect(validated).not.toHaveProperty("promote");
  });
});
