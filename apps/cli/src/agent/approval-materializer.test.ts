import { describe, expect, it } from "vitest";

import type { SemanticAction } from "@lhic/schema";
import { createActionApproval } from "@lhic/security";

import { materializeActionApproval } from "./approval-materializer.js";

const action: SemanticAction = {
  type: "navigate",
  intent: "Open the documentation",
  target: "https://example.test",
  methodPreference: ["api"],
  riskLevel: "medium",
};

describe("materializeActionApproval", () => {
  it("creates a complete approval bound to the exact action", () => {
    const approval = materializeActionApproval(
      action,
      { approvedBy: "alice" },
      { production: false, now: new Date("2026-08-13T00:00:00.000Z") },
    );
    expect(approval).toMatchObject({
      approvedBy: "alice",
      actionHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      approvedAt: "2026-08-13T00:00:00.000Z",
    });
  });

  it("rejects a mismatched external approval and unsigned production decision", () => {
    const other = { ...action, target: "https://different.test" };
    const mismatched = createActionApproval(other, "alice");
    expect(() =>
      materializeActionApproval(
        action,
        { approvedBy: "alice", approval: mismatched },
        { production: false },
      ),
    ).toThrow("does not match");
    expect(() =>
      materializeActionApproval(
        action,
        { approvedBy: "alice" },
        { production: true },
      ),
    ).toThrow("fully signed external approval");
  });
});
