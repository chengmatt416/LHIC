import { describe, expect, it } from "vitest";

import type {
  HumanIntentCorrectionBinding,
  LearnLoopRule,
  SignedHumanIntentCorrectionApproval,
} from "@lhic/controller";

import { TaskService } from "./task-service.js";

describe("TaskService correction ingestion wiring", () => {
  it("forwards to the explicitly configured ingestion port", () => {
    const expectedRule = { id: "rule-1" } as LearnLoopRule;
    let observed = false;
    const service = createService({
      ingestCorrection: () => {
        observed = true;
        return expectedRule;
      },
    });
    const result = service.ingestHumanIntentCorrection(
      {} as HumanIntentCorrectionBinding,
      {} as SignedHumanIntentCorrectionApproval,
    );
    expect(observed).toBe(true);
    expect(result).toBe(expectedRule);
  });

  it("fails closed when a test replaces admission without an ingestion port", () => {
    const service = createService();
    expect(() =>
      service.ingestHumanIntentCorrection(
        {} as HumanIntentCorrectionBinding,
        {} as SignedHumanIntentCorrectionApproval,
      ),
    ).toThrow("not configured");
  });
});

function createService(correctionIngestion?: {
  ingestCorrection(
    binding: HumanIntentCorrectionBinding,
    approval: SignedHumanIntentCorrectionApproval,
  ): LearnLoopRule;
}): TaskService {
  return new TaskService(
    process.cwd(),
    { get: async () => undefined } as never,
    undefined,
    {
      humanIntentAdmission: {
        evaluate: () => {
          throw new Error("not used");
        },
      },
      ...(correctionIngestion
        ? { humanIntentCorrectionIngestion: correctionIngestion }
        : {}),
    },
  );
}
